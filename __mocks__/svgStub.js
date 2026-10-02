/* eslint-env jest */
/**
 * A light stand-in for react-native-svg, used explicitly by the charge-stage
 * suites: jest.mock('react-native-svg', () => require('<root>/__mocks__/svgStub')).
 * Every element renders as a host element carrying its props, and each <Svg>
 * render is counted by viewBox so a test can prove the card art (viewBox
 * "0 59 320 202") is drawn once per mount.
 */
const React = require('react');

const renders = {};

function host(name) {
  const Component = ({children, ...rest}) =>
    React.createElement(name, rest, children);
  Component.displayName = name;
  return Component;
}

const Svg = ({children, ...rest}) => {
  const key = rest.viewBox || 'none';
  renders[key] = (renders[key] || 0) + 1;
  return React.createElement('RNSVGSvg', rest, children);
};

const stub = {
  __esModule: true,
  default: Svg,
  Svg,
  Circle: host('RNSVGCircle'),
  ClipPath: host('RNSVGClipPath'),
  Defs: host('RNSVGDefs'),
  G: host('RNSVGGroup'),
  Line: host('RNSVGLine'),
  LinearGradient: host('RNSVGLinearGradient'),
  Path: host('RNSVGPath'),
  RadialGradient: host('RNSVGRadialGradient'),
  Rect: host('RNSVGRect'),
  Stop: host('RNSVGStop'),
  Text: host('RNSVGText'),
  __svgRenders: renders,
  __resetSvgRenders: () => {
    Object.keys(renders).forEach(key => delete renders[key]);
  },
};

module.exports = stub;
