import pkg from '../../package.json';

/**
 * The app version the release lanes stamp into package.json alongside the
 * native version strings (fastlane `update_*_version_from_tag`). One source
 * for every place that prints "Flash POS vX.Y.Z" so a hardcoded literal can
 * never drift again (the support chat reported v0.3.1 on a 2.4.0 build).
 */
export const APP_VERSION: string = pkg.version;
