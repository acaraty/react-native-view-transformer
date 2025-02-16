import React from 'react';
import ReactNative, { View, Animated, Easing, NativeModules } from 'react-native';

import { createResponder } from 'react-native-gesture-responder';
import Scroller from 'react-native-scroller';
import {
  Rect,
  Transform,
  transformedRect,
  availableTranslateSpace,
  fitCenterRect,
  alignedRect,
  getTransform,
} from './TransformUtils';

type Props = {
  /**
   * Use false to disable transform. Default is true.
   */
  enableTransform?: boolean,

  /**
   * Use false to disable scaling. Default is true.
   */
  enableScale?: boolean,

  /**
   * Use false to disable translateX/translateY. Default is true.
   */
  enableTranslate?: boolean,

  /**
   * Default is 20
   */
  maxOverScrollDistance?: number,

  maxScale?: number,
  contentAspectRatio: number,

  /**
   * Use true to enable resistance effect on over pulling. Default is false.
   */
  enableResistance?: boolean,

  onViewTransformed: Function,

  onTransformGestureReleased: Function,

  onSingleTapConfirmed: Function,
};

export default class ViewTransformer extends React.Component<Props> {
  static defaultProps = {
    maxOverScrollDistance: 20,
    enableScale: true,
    enableTranslate: true,
    enableTransform: true,
    maxScale: 1,
    enableResistance: false,
  };

  static Rect = Rect;

  static getTransform = getTransform;

  constructor(props) {
    super(props);
    this.state = {
      // transform state
      scale: 1,
      translateX: 0,
      translateY: 0,

      // animation state
      animator: new Animated.Value(0),

      // layout
      width: 0,
      height: 0,
      pageX: 0,
      pageY: 0,
    };
    this._viewPortRect = new Rect(); // A holder to avoid new too much

    this.cancelAnimation = this.cancelAnimation.bind(this);
    this.contentRect = this.contentRect.bind(this);
    this.transformedContentRect = this.transformedContentRect.bind(this);
    this.animate = this.animate.bind(this);

    this.scroller = new Scroller(true, (dx, dy, scroller) => {
      if (dx === 0 && dy === 0 && scroller.isFinished()) {
        this.animateBounce();
        return;
      }

      this.updateTransform({
        translateX: this.state.translateX + dx / this.state.scale,
        translateY: this.state.translateY + dy / this.state.scale,
      });
    });
  }

  viewPortRect() {
    this._viewPortRect.set(0, 0, this.state.width, this.state.height);
    return this._viewPortRect;
  }

  contentRect() {
    let rect = this.viewPortRect().copy();
    if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
      rect = fitCenterRect(this.props.contentAspectRatio, rect);
    }
    return rect;
  }

  transformedContentRect() {
    let rect = transformedRect(this.viewPortRect(), this.currentTransform());
    if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
      rect = fitCenterRect(this.props.contentAspectRatio, rect);
    }
    return rect;
  }

  currentTransform() {
    return new Transform(this.state.scale, this.state.translateX, this.state.translateY);
  }

  componentWillMount() {
    this.gestureResponder = createResponder({
      onStartShouldSetResponder: (evt, gestureState) => true,
      onMoveShouldSetResponderCapture: (evt, gestureState) => true,
      // onMoveShouldSetResponder: this.handleMove,
      onResponderMove: this.onResponderMove.bind(this),
      onResponderGrant: this.onResponderGrant.bind(this),
      onResponderRelease: this.onResponderRelease.bind(this),
      onResponderTerminate: this.onResponderRelease.bind(this),
      onResponderTerminationRequest: (evt, gestureState) => false, // Do not allow parent view to intercept gesture
      onResponderSingleTapConfirmed: (evt, gestureState) => {
        this.props.onSingleTapConfirmed && this.props.onSingleTapConfirmed();
      },
    });
  }

  componentDidUpdate(prevProps, prevState) {
    this.props.onViewTransformed &&
      this.props.onViewTransformed({
        scale: this.state.scale,
        translateX: this.state.translateX,
        translateY: this.state.translateY,
      });
  }

  componentWillUnmount() {
    this.cancelAnimation();
  }

  render() {
    let { gestureResponder } = this;
    if (!this.props.enableTransform) {
      gestureResponder = {};
    }

    return (
      <View {...this.props} {...gestureResponder} ref="innerViewRef" onLayout={this.onLayout.bind(this)}>
        <View
          style={{
            flex: 1,
            transform: [
              { scale: this.state.scale },
              { translateX: this.state.translateX },
              { translateY: this.state.translateY },
            ],
          }}
        >
          {this.props.children}
        </View>
      </View>
    );
  }

  onLayout(e) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== this.state.width || height !== this.state.height) {
      this.setState({ width, height });
    }
    this.measureLayout();

    this.props.onLayout && this.props.onLayout(e);
  }

  measureLayout() {
    const handle = ReactNative.findNodeHandle(this.refs.innerViewRef);
    NativeModules.UIManager.measure(handle, (x, y, width, height, pageX, pageY) => {
      if (typeof pageX === 'number' && typeof pageY === 'number') {
        // avoid undefined values on Android devices
        if (this.state.pageX !== pageX || this.state.pageY !== pageY) {
          this.setState({
            pageX,
            pageY,
          });
        }
      }
    });
  }

  onResponderGrant(evt, gestureState) {
    this.props.onTransformStart && this.props.onTransformStart();
    this.setState({ responderGranted: true });
    this.measureLayout();
  }

  onResponderMove(evt, gestureState) {
    this.cancelAnimation();

    let dx = gestureState.moveX - gestureState.previousMoveX;
    let dy = gestureState.moveY - gestureState.previousMoveY;
    if (this.props.enableResistance) {
      const d = this.applyResistance(dx, dy);
      dx = d.dx;
      dy = d.dy;
    }

    if (!this.props.enableTranslate) {
      dx = dy = 0;
    }

    let transform = {};
    if (gestureState.previousPinch && gestureState.pinch && this.props.enableScale) {
      const scaleBy = gestureState.pinch / gestureState.previousPinch;
      const pivotX = gestureState.moveX - this.state.pageX;
      const pivotY = gestureState.moveY - this.state.pageY;

      const rect = transformedRect(
        transformedRect(this.contentRect(), this.currentTransform()),
        new Transform(scaleBy, dx, dy, {
          x: pivotX,
          y: pivotY,
        }),
      );
      transform = getTransform(this.contentRect(), rect);
    } else {
      if (Math.abs(dx) > 2 * Math.abs(dy)) {
        dy = 0;
      } else if (Math.abs(dy) > 2 * Math.abs(dx)) {
        dx = 0;
      }
      transform.translateX = this.state.translateX + dx / this.state.scale;
      transform.translateY = this.state.translateY + dy / this.state.scale;
    }

    this.updateTransform(transform);
    return true;
  }

  onResponderRelease(evt, gestureState) {
    const handled =
      this.props.onTransformGestureReleased &&
      this.props.onTransformGestureReleased({
        scale: this.state.scale,
        translateX: this.state.translateX,
        translateY: this.state.translateY,
      });
    if (handled) {
      return;
    }

    if (gestureState.doubleTapUp) {
      if (!this.props.enableScale) {
        this.animateBounce();
        return;
      }
      let pivotX = 0;
      let pivotY = 0;
      if (gestureState.dx || gestureState.dy) {
        pivotX = gestureState.moveX - this.state.pageX;
        pivotY = gestureState.moveY - this.state.pageY;
      } else {
        pivotX = gestureState.x0 - this.state.pageX;
        pivotY = gestureState.y0 - this.state.pageY;
      }

      this.performDoubleTapUp(pivotX, pivotY);
    } else if (this.props.enableTranslate) {
      this.performFling(gestureState.vx, gestureState.vy);
    } else {
      this.animateBounce();
    }
  }

  performFling(vx, vy) {
    const startX = 0;
    const startY = 0;
    let maxX;
    let minX;
    let maxY;
    let minY;
    const availablePanDistance = availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());
    if (vx > 0) {
      minX = 0;
      if (availablePanDistance.left > 0) {
        maxX = availablePanDistance.left + this.props.maxOverScrollDistance;
      } else {
        maxX = 0;
      }
    } else {
      maxX = 0;
      if (availablePanDistance.right > 0) {
        minX = -availablePanDistance.right - this.props.maxOverScrollDistance;
      } else {
        minX = 0;
      }
    }
    if (vy > 0) {
      minY = 0;
      if (availablePanDistance.top > 0) {
        maxY = availablePanDistance.top + this.props.maxOverScrollDistance;
      } else {
        maxY = 0;
      }
    } else {
      maxY = 0;
      if (availablePanDistance.bottom > 0) {
        minY = -availablePanDistance.bottom - this.props.maxOverScrollDistance;
      } else {
        minY = 0;
      }
    }

    vx *= 1000; // per second
    vy *= 1000;
    if (Math.abs(vx) > 2 * Math.abs(vy)) {
      vy = 0;
    } else if (Math.abs(vy) > 2 * Math.abs(vx)) {
      vx = 0;
    }

    this.scroller.fling(startX, startY, vx, vy, minX, maxX, minY, maxY);
  }

  performDoubleTapUp(pivotX, pivotY) {
    console.log(`performDoubleTapUp...pivot=${pivotX}, ${pivotY}`);
    const curScale = this.state.scale;
    let scaleBy;
    if (curScale > (1 + this.props.maxScale) / 2) {
      scaleBy = 1 / curScale;
    } else {
      scaleBy = this.props.maxScale / curScale;
    }

    let rect = transformedRect(
      this.transformedContentRect(),
      new Transform(scaleBy, 0, 0, {
        x: pivotX,
        y: pivotY,
      }),
    );
    rect = transformedRect(
      rect,
      new Transform(1, this.viewPortRect().centerX() - pivotX, this.viewPortRect().centerY() - pivotY),
    );
    rect = alignedRect(rect, this.viewPortRect());

    this.animate(rect);
  }

  applyResistance(dx, dy) {
    const availablePanDistance = availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());

    if ((dx > 0 && availablePanDistance.left < 0) || (dx < 0 && availablePanDistance.right < 0)) {
      dx /= 3;
    }
    if ((dy > 0 && availablePanDistance.top < 0) || (dy < 0 && availablePanDistance.bottom < 0)) {
      dy /= 3;
    }
    return {
      dx,
      dy,
    };
  }

  cancelAnimation() {
    this.state.animator.stopAnimation();
  }

  animate(targetRect, durationInMillis) {
    let duration = 200;
    if (durationInMillis) {
      duration = durationInMillis;
    }

    const fromRect = this.transformedContentRect();
    if (fromRect.equals(targetRect)) {
      console.log('animate...equal rect, skip animation');
      return;
    }

    this.state.animator.removeAllListeners();
    this.state.animator.setValue(0);
    this.state.animator.addListener((state) => {
      const progress = state.value;

      const left = fromRect.left + (targetRect.left - fromRect.left) * progress;
      const right = fromRect.right + (targetRect.right - fromRect.right) * progress;
      const top = fromRect.top + (targetRect.top - fromRect.top) * progress;
      const bottom = fromRect.bottom + (targetRect.bottom - fromRect.bottom) * progress;

      const transform = getTransform(this.contentRect(), new Rect(left, top, right, bottom));
      this.updateTransform(transform);
    });

    Animated.timing(this.state.animator, {
      toValue: 1,
      duration,
      easing: Easing.inOut(Easing.ease),
    }).start();
  }

  animateBounce() {
    const curScale = this.state.scale;
    const minScale = 1;
    const { maxScale } = this.props;
    let scaleBy = 1;
    if (curScale > maxScale) {
      scaleBy = maxScale / curScale;
    } else if (curScale < minScale) {
      scaleBy = minScale / curScale;
    }

    let rect = transformedRect(
      this.transformedContentRect(),
      new Transform(scaleBy, 0, 0, {
        x: this.viewPortRect().centerX(),
        y: this.viewPortRect().centerY(),
      }),
    );
    rect = alignedRect(rect, this.viewPortRect());
    this.animate(rect);
  }

  // Above are private functions. Do not use them if you don't known what you are doing.
  // ***********************************************************************************
  // Below are public functions. Feel free to use them.

  updateTransform(transform) {
    this.setState(transform);
  }

  forceUpdateTransform(transform) {
    this.setState(transform);
  }

  getAvailableTranslateSpace() {
    return availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());
  }
}
