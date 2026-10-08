package com.lacaksmb.master.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.lacaksmb.master.ui.theme.Accent300
import com.lacaksmb.master.ui.theme.Accent400
import com.lacaksmb.master.ui.theme.Accent500
import com.lacaksmb.master.ui.theme.Base100
import com.lacaksmb.master.ui.theme.Base300
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import com.lacaksmb.master.ui.theme.Base500
import com.lacaksmb.master.ui.theme.Base600
import com.lacaksmb.master.ui.theme.Base700
import com.lacaksmb.master.ui.theme.Base800
import com.lacaksmb.master.ui.theme.Base850
import com.lacaksmb.master.ui.theme.Base900
import com.lacaksmb.master.ui.theme.Base950
import com.lacaksmb.master.ui.theme.ButtonCornerRadius
import com.lacaksmb.master.ui.theme.CardCornerRadius
import com.lacaksmb.master.ui.theme.Copper400
import com.lacaksmb.master.ui.theme.Copper500
import com.lacaksmb.master.ui.theme.Danger400
import com.lacaksmb.master.ui.theme.Danger500
import com.lacaksmb.master.ui.theme.Warning400
import com.lacaksmb.master.ui.theme.Warning500

// Komponen UI bersama yang meniru bahasa visual web-dashboard
// (lihat web-dashboard/src/components/ui, file BaseCard.vue dkk) — panel
// kontrol keamanan gelap, aksen teal/tembaga. Dipakai di semua layar supaya
// master app & web dashboard terasa satu produk.

// ---- Badge (meniru BaseBadge.vue) -----------------------------------------

enum class BadgeVariant { Neutral, Success, Warning, Danger, Accent }

private data class BadgeColors(val background: Color, val text: Color)

private fun colorsFor(variant: BadgeVariant): BadgeColors = when (variant) {
    BadgeVariant.Neutral -> BadgeColors(Base800, Base300)
    BadgeVariant.Success -> BadgeColors(Accent500.copy(alpha = 0.16f), Accent300)
    BadgeVariant.Warning -> BadgeColors(Warning500.copy(alpha = 0.16f), Warning400)
    BadgeVariant.Danger -> BadgeColors(Danger500.copy(alpha = 0.16f), Danger400)
    BadgeVariant.Accent -> BadgeColors(Copper500.copy(alpha = 0.16f), Copper400)
}

@Composable
fun StatusBadge(text: String, variant: BadgeVariant = BadgeVariant.Neutral, modifier: Modifier = Modifier) {
    val colors = colorsFor(variant)
    Row(
        modifier = modifier
            .background(colors.background, CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text,
            color = colors.text,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
        )
    }
}

/** Pemetaan status device ke varian badge, konsisten dengan web dashboard. */
fun deviceStatusBadgeVariant(status: String): BadgeVariant = when (status.lowercase()) {
    "online", "unlocked", "active" -> BadgeVariant.Success
    "locked", "offline", "error" -> BadgeVariant.Danger
    "pending" -> BadgeVariant.Warning
    else -> BadgeVariant.Neutral
}

// ---- Card (meniru BaseCard.vue) --------------------------------------------

@Composable
fun SectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(20.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(CardCornerRadius),
        colors = CardDefaults.cardColors(containerColor = Base900),
        border = BorderStroke(1.dp, Base800),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        if (title != null || actions != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    if (title != null) {
                        Text(
                            title,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = Base50,
                        )
                    }
                    if (subtitle != null) {
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = Base400,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
                if (actions != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        actions()
                    }
                }
            }
            HorizontalDivider(color = Base800)
        }
        Column(modifier = Modifier.padding(contentPadding)) {
            content()
        }
    }
}

// ---- Button (meniru BaseButton.vue) ----------------------------------------

enum class AppButtonVariant { Primary, Outline, Ghost, Danger }

@Composable
fun AppButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: AppButtonVariant = AppButtonVariant.Primary,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val shape = RoundedCornerShape(ButtonCornerRadius)
    val content: @Composable RowScope.() -> Unit = {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = LocalContentColorFor(variant),
            )
        } else if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
    }

    when (variant) {
        AppButtonVariant.Primary -> Button(
            onClick = onClick,
            enabled = enabled && !loading,
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = Accent500,
                contentColor = Base950,
                disabledContainerColor = Accent500.copy(alpha = 0.4f),
                disabledContentColor = Base950.copy(alpha = 0.7f),
            ),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            modifier = modifier,
        ) { Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() } }

        AppButtonVariant.Danger -> Button(
            onClick = onClick,
            enabled = enabled && !loading,
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = Danger500,
                contentColor = Base50,
                disabledContainerColor = Danger500.copy(alpha = 0.4f),
                disabledContentColor = Base50.copy(alpha = 0.7f),
            ),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            modifier = modifier,
        ) { Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() } }

        AppButtonVariant.Outline -> OutlinedButton(
            onClick = onClick,
            enabled = enabled && !loading,
            shape = shape,
            border = BorderStroke(1.dp, Base600),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Base100, disabledContentColor = Base500),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            modifier = modifier,
        ) { Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() } }

        AppButtonVariant.Ghost -> TextButton(
            onClick = onClick,
            enabled = enabled && !loading,
            shape = shape,
            colors = ButtonDefaults.textButtonColors(contentColor = Base300, disabledContentColor = Base500),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            modifier = modifier,
        ) { Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() } }
    }
}

@Composable
private fun LocalContentColorFor(variant: AppButtonVariant): Color = when (variant) {
    AppButtonVariant.Primary -> Base950
    AppButtonVariant.Danger -> Base50
    AppButtonVariant.Outline -> Base100
    AppButtonVariant.Ghost -> Base300
}

// ---- TopAppBar themed -------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppTopBar(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    TopAppBar(
        title = { Text(title, color = Base50, fontWeight = FontWeight.SemiBold) },
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.Filled.ArrowBack,
                        contentDescription = "Kembali",
                        tint = Base300,
                    )
                }
            }
        },
        actions = actions,
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Base900,
            titleContentColor = Base50,
            navigationIconContentColor = Base300,
            actionIconContentColor = Base300,
        ),
    )
}

// ---- TextField themed (meniru BaseInput.vue) --------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun appTextFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Accent500,
    unfocusedBorderColor = Base700,
    disabledBorderColor = Base800,
    focusedLabelColor = Accent400,
    unfocusedLabelColor = Base400,
    cursorColor = Accent500,
    focusedTextColor = Base100,
    unfocusedTextColor = Base100,
    focusedContainerColor = Base850,
    unfocusedContainerColor = Base850,
)
