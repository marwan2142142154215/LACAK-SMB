import { defineConfig } from '@adonisjs/core/bodyparser'

const bodyParserConfig = defineConfig({
    /**
     * Parse request bodies for these HTTP methods.
     * Keep this aligned with methods that receive payloads in your routes.
     */
    allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],

    /**
     * Config for the "application/x-www-form-urlencoded"
     * content-type parser.
     */
    form: {
        /**
         * Normalize empty string values to null.
         */
        convertEmptyStringsToNull: true,

        /**
         * Content types handled by the form parser.
         */
        types: ['application/x-www-form-urlencoded'],
    },

    /**
     * Config for the JSON parser.
     */
    json: {
        /**
         * Normalize empty string values to null.
         */
        convertEmptyStringsToNull: true,

        /**
         * Content types handled by the JSON parser.
         */
        types: [
            'application/json',
            'application/json-patch+json',
            'application/vnd.api+json',
            'application/csp-report',
        ],
    },

    /**
     * Config for the "multipart/form-data" content-type parser.
     * File uploads are handled by the multipart parser.
     */
    multipart: {
        /**
         * Automatically process uploaded files into the system tmp directory.
         */
        autoProcess: true,

        /**
         * Normalize empty string values to null.
         */
        convertEmptyStringsToNull: true,

        /**
         * Routes where multipart processing is handled manually.
         */
        processManually: [],

        /**
         * Maximum accepted payload size for multipart requests.
         * Unggah APK di backend-api: apk_file max:204800 KB (200 MB). Batas
         * di sini sedikit di atasnya supaya berkas yang terlalu besar tetap
         * dijawab 422 dengan pesan validasi Laravel, bukan 413.
         */
        limit: '210mb',

        /**
         * Content types handled by the multipart parser.
         */
        types: ['multipart/form-data'],
    },
})

export default bodyParserConfig
