package com.lacaksmb.live.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.BlurOn
import androidx.compose.material.icons.filled.Block
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lacaksmb.live.service.BackgroundChoice
import com.lacaksmb.live.service.CameraBackground
import com.lacaksmb.live.service.LiveBroadcastService
import com.lacaksmb.live.ui.theme.Accent500
import com.lacaksmb.live.ui.theme.Base300
import com.lacaksmb.live.ui.theme.Base400
import com.lacaksmb.live.ui.theme.Base700
import com.lacaksmb.live.ui.theme.Base850
import com.lacaksmb.live.ui.theme.Danger400
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pilih background kamera siaran: kamera asli, blur, gradasi bawaan, atau
 * gambar dari galeri. Diproses di HP; atasan melihat hasilnya. Bisa dipilih
 * sebelum Mulai kerja maupun di tengah siaran ([live] = langsung dipasang).
 */
@Composable
fun BackgroundControl(live: Boolean) {
    val context = LocalContext.current
    val app = context.applicationContext
    val scope = rememberCoroutineScope()
    var choice by remember { mutableStateOf(CameraBackground.load(app)) }
    // Naik tiap gambar galeri baru disimpan, supaya pratinjau dimuat ulang.
    var customVersion by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }

    fun select(next: BackgroundChoice) {
        error = null
        choice = next
        CameraBackground.save(app, next)
        if (live) LiveBroadcastService.backgroundChanged(app)
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { CameraBackground.importCustom(app, uri) }.isSuccess }
            if (ok) {
                customVersion++
                select(BackgroundChoice.Custom)
            } else {
                error = "Gambar tidak bisa dibaca. Coba gambar lain."
            }
        }
    }

    val customThumb = remember(customVersion) {
        val file = CameraBackground.customFile(app)
        if (file.exists()) {
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = 8 })?.asImageBitmap()
        } else {
            null
        }
    }

    Column(modifier = Modifier.padding(top = 16.dp)) {
        Text("Background kamera", style = MaterialTheme.typography.titleSmall, color = Base300)
        Text(
            "Diproses di HP Anda; atasan melihat hasilnya. Cek wajah tetap berjalan.",
            style = MaterialTheme.typography.bodySmall,
            color = Base400,
            modifier = Modifier.padding(top = 2.dp),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .padding(top = 10.dp)
                .horizontalScroll(rememberScrollState()),
        ) {
            Tile("Asli", choice == BackgroundChoice.None, { select(BackgroundChoice.None) }) {
                Icon(Icons.Filled.Block, null, tint = Base300)
            }
            Tile("Blur", choice == BackgroundChoice.Blur, { select(BackgroundChoice.Blur) }) {
                Icon(Icons.Filled.BlurOn, null, tint = Accent500)
            }
            CameraBackground.PRESETS.forEachIndexed { index, preset ->
                Tile(
                    preset.name,
                    choice == BackgroundChoice.Preset(index),
                    { select(BackgroundChoice.Preset(index)) },
                    fill = Brush.linearGradient(preset.colors.map { Color(it) }),
                )
            }
            if (customThumb != null) {
                Tile("Gambar Anda", choice == BackgroundChoice.Custom, { select(BackgroundChoice.Custom) }) {
                    Image(customThumb, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
            }
            Tile("Galeri", selected = false, onClick = {
                picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) {
                Icon(Icons.Filled.AddPhotoAlternate, null, tint = Base300)
            }
        }
        error?.let { Text(it, color = Danger400, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
    }
}

@Composable
private fun Tile(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    fill: Brush? = null,
    content: @Composable () -> Unit = {},
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .width(76.dp)
            .clickable(role = Role.RadioButton, onClickLabel = label, onClick = onClick),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(width = 76.dp, height = 52.dp)
                .clip(RoundedCornerShape(10.dp))
                .then(if (fill != null) Modifier.background(fill) else Modifier.background(Base850))
                .border(if (selected) 2.dp else 1.dp, if (selected) Accent500 else Base700, RoundedCornerShape(10.dp)),
        ) { content() }
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = if (selected) Accent500 else Base400,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}
