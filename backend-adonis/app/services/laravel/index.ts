import env from '#start/env'
import { LaravelEncrypter } from '#services/laravel/crypt'
import { LaravelUrlSigner } from '#services/laravel/signed_url'

/** Encrypter & signer dengan APP_KEY backend-api, siap pakai. */
export const laravelEncrypter = new LaravelEncrypter(env.get('LARAVEL_APP_KEY').release())

export const laravelUrlSigner = new LaravelUrlSigner(
    env.get('LARAVEL_APP_KEY').release(),
    env.get('LARAVEL_APP_URL')
)

/** Nilai personal_access_tokens.tokenable_type & model_has_roles.model_type untuk user. */
export const LARAVEL_USER_MORPH = 'App\\Models\\User'
