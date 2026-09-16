import rootConfig from '../../eslint.config.mjs'

/** Standalone scripts (e.g. audio generation) are not part of the server tsconfig project. */
export default [...rootConfig, { ignores: ['scripts/**'] }]
