package com.lacaksmb.master.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

// rounded-2xl (card) ~16dp, rounded-lg (button/input) ~8dp — sama seperti
// web-dashboard (BaseCard.vue, BaseButton.vue, BaseInput.vue).
val CardCornerRadius = 16.dp
val ButtonCornerRadius = 8.dp
val BadgeCornerRadius = 999.dp

val LacakShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(ButtonCornerRadius),
    medium = RoundedCornerShape(ButtonCornerRadius),
    large = RoundedCornerShape(CardCornerRadius),
    extraLarge = RoundedCornerShape(CardCornerRadius),
)
