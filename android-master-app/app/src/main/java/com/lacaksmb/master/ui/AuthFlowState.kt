package com.lacaksmb.master.ui

/**
 * Jembatan sementara antara LoginScreen dan TwoFactorScreen (challenge/setup
 * token hidup hanya selama alur login berjalan, tidak perlu disimpan
 * persisten lewat Navigation args yang berat untuk string sepanjang ini).
 */
object AuthFlowState {
    var challengeToken: String? = null
    var setupToken: String? = null
    var qrCodeSvg: String? = null
    var secretManualEntry: String? = null
    var isSetupMode: Boolean = false

    fun clear() {
        challengeToken = null
        setupToken = null
        qrCodeSvg = null
        secretManualEntry = null
        isSetupMode = false
    }
}
