import { Exception } from '@adonisjs/core/exceptions'

/** 401 dengan bentuk JSON yang sama seperti backend-api (lihat handler.ts). */
export default class UnauthenticatedException extends Exception {
    static status = 401
    static code = 'E_UNAUTHENTICATED'
    static message = 'Belum masuk atau token tidak berlaku'
}
