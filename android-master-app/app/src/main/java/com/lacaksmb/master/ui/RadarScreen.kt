package com.lacaksmb.master.ui

import android.Manifest
import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.navigation.NavHostController
import com.lacaksmb.master.ble.BleRadarScanner
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.Device
import com.lacaksmb.master.ui.components.AppTopBar
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import com.lacaksmb.master.ui.theme.Base900
import com.lacaksmb.master.ui.theme.Warning400
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RadarScreen(apiClient: ApiClient, navController: NavHostController) {
    val context = LocalContext.current
    var devices by remember { mutableStateOf<List<Device>>(emptyList()) }
    var bleGranted by remember { mutableStateOf(Build.VERSION.SDK_INT < Build.VERSION_CODES.S) }
    val scanner = remember { BleRadarScanner(context) }
    val sightings by scanner.sightings.collectAsState()

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        bleGranted = granted
    }

    LaunchedEffect(Unit) {
        when (val result = apiClient.listDevices()) {
            is ApiResult.Ok -> {
                val items = result.data?.optJSONArray("items")
                devices = (0 until (items?.length() ?: 0)).map { Device.fromJson(items!!.getJSONObject(it)) }
            }
            is ApiResult.Fail -> {}
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissionLauncher.launch(Manifest.permission.BLUETOOTH_SCAN)
        }
    }

    DisposableEffect(bleGranted) {
        if (bleGranted) scanner.start()
        onDispose { scanner.stop() }
    }

    Scaffold(
        topBar = {
            AppTopBar(title = "Radar Lokasi", onBack = { navController.popBackStack() })
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Box(modifier = Modifier.fillMaxWidth().height(320.dp)) {
                DeviceMap(devices)
            }

            Text(
                "Jarak dekat (BLE) — makin kuat sinyal, makin dekat device",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = Base50,
                modifier = Modifier.padding(16.dp),
            )

            if (!bleGranted) {
                Text(
                    "Izin Bluetooth belum diberikan — radar jarak dekat tidak aktif.",
                    color = Warning400,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }

            val devicesByUuid = devices.associateBy { it.deviceUuid }
            LazyColumn {
                items(sightings.values.toList(), key = { it.deviceUuid }) { sighting ->
                    val matchedDevice = devicesByUuid[sighting.deviceUuid]
                    SectionCard(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                    ) {
                        Text(
                            matchedDevice?.deviceName ?: "Device tidak dikenal (${sighting.deviceUuid.take(8)}...)",
                            color = Base50,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        val distance = BleRadarScanner.estimateDistanceMeters(sighting.rssi)
                        Text(
                            "RSSI ${sighting.rssi} dBm · perkiraan ${"%.1f".format(distance)} meter",
                            style = MaterialTheme.typography.bodySmall,
                            color = Base400,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceMap(devices: List<Device>) {
    AndroidView(
        factory = {
            MapView(it).apply {
                setMultiTouchControls(true)
                controller.setZoom(13.0)
                controller.setCenter(GeoPoint(3.5952, 98.6722))
            }
        },
        update = { mapView ->
            mapView.overlays.clear()
            val points = mutableListOf<GeoPoint>()
            devices.forEach { device ->
                val lat = device.latestLocation?.latitude
                val lng = device.latestLocation?.longitude
                if (lat != null && lng != null) {
                    val point = GeoPoint(lat, lng)
                    points += point
                    val marker = Marker(mapView)
                    marker.position = point
                    marker.title = device.deviceName
                    marker.snippet = device.status
                    mapView.overlays.add(marker)
                }
            }
            if (points.isNotEmpty()) {
                mapView.controller.setCenter(points.first())
            }
            mapView.invalidate()
        },
        modifier = Modifier.fillMaxSize(),
    )
}
