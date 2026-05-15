export const URL_ALCHEMIST_VERSION =
  typeof __URL_ALCHEMIST_VERSION__ === 'string' && __URL_ALCHEMIST_VERSION__.trim()
    ? __URL_ALCHEMIST_VERSION__
    : 'development';

export const URL_ALCHEMIST_BUILD_TIME =
  typeof __URL_ALCHEMIST_BUILD_TIME__ === 'string' && __URL_ALCHEMIST_BUILD_TIME__.trim()
    ? __URL_ALCHEMIST_BUILD_TIME__
    : 'development';
