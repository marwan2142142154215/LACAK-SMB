package com.lacaksmb.master

import android.app.Application
import org.osmdroid.config.Configuration

class MasterApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // osmdroid butuh user-agent unik (kebijakan tile server OSM) dan
        // sengaja diarahkan ke cache internal app supaya tidak perlu minta
        // izin penyimpanan eksternal sama sekali.
        Configuration.getInstance().apply {
            userAgentValue = packageName
            osmdroidBasePath = cacheDir
            osmdroidTileCache = cacheDir.resolve("osmdroid-tiles").apply { mkdirs() }
        }
    }
}
