package com.lacaksmb.master.data

import org.json.JSONObject

data class DeviceLocation(
    val id: Int,
    val deviceId: Int,
    val source: String,
    val latitude: Double?,
    val longitude: Double?,
    val bleDistanceMeters: Double?,
    val bleRssi: Int?,
    val recordedAt: String?,
) {
    companion object {
        fun fromJson(json: JSONObject): DeviceLocation = DeviceLocation(
            id = json.optInt("id"),
            deviceId = json.optInt("device_id"),
            source = json.optString("source"),
            latitude = json.optString("latitude").toDoubleOrNull(),
            longitude = json.optString("longitude").toDoubleOrNull(),
            bleDistanceMeters = if (json.isNull("ble_distance_meters")) null else json.optString("ble_distance_meters").toDoubleOrNull(),
            bleRssi = if (json.isNull("ble_rssi")) null else json.optInt("ble_rssi"),
            recordedAt = json.optString("recorded_at", null),
        )
    }
}

data class Device(
    val id: Int,
    val organizationId: Int,
    val consentDocumentId: Int?,
    val deviceName: String,
    val deviceUuid: String,
    val androidVersion: String,
    val appBuildVersion: String,
    val status: String,
    val batteryLevel: Int?,
    val lastSeenAt: String?,
    val enrolledAt: String?,
    val isActive: Boolean,
    val latestLocation: DeviceLocation?,
) {
    companion object {
        fun fromJson(json: JSONObject): Device = Device(
            id = json.optInt("id"),
            organizationId = json.optInt("organization_id"),
            consentDocumentId = if (json.isNull("consent_document_id")) null else json.optInt("consent_document_id"),
            deviceName = json.optString("device_name"),
            deviceUuid = json.optString("device_uuid"),
            androidVersion = json.optString("android_version"),
            appBuildVersion = json.optString("app_build_version"),
            status = json.optString("status"),
            batteryLevel = if (json.isNull("battery_level")) null else json.optInt("battery_level"),
            lastSeenAt = json.optString("last_seen_at", null),
            enrolledAt = json.optString("enrolled_at", null),
            isActive = json.optBoolean("is_active", true),
            latestLocation = json.optJSONObject("latest_location")?.let { DeviceLocation.fromJson(it) },
        )
    }
}

data class GeofenceRule(
    val id: Int,
    val organizationId: Int,
    val ruleName: String,
    val allowedSsid: String?,
    val allowedIpCidr: String?,
    val maxDistanceMeters: Int?,
    val isActive: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject): GeofenceRule = GeofenceRule(
            id = json.optInt("id"),
            organizationId = json.optInt("organization_id"),
            ruleName = json.optString("rule_name"),
            allowedSsid = json.optString("allowed_ssid", null),
            allowedIpCidr = json.optString("allowed_ip_cidr", null),
            maxDistanceMeters = if (json.isNull("max_distance_meters")) null else json.optInt("max_distance_meters"),
            isActive = json.optBoolean("is_active", true),
        )
    }
}

data class ConsentDocument(
    val id: Int,
    val organizationId: Int,
    val subjectName: String,
    val signerName: String,
    val signerRole: String,
    val documentUrl: String?,
    val signedAt: String?,
    val validUntil: String?,
    val revokedAt: String?,
    val isActive: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject): ConsentDocument = ConsentDocument(
            id = json.optInt("id"),
            organizationId = json.optInt("organization_id"),
            subjectName = json.optString("subject_name"),
            signerName = json.optString("signer_name"),
            signerRole = json.optString("signer_role"),
            documentUrl = json.optString("document_url", null),
            signedAt = json.optString("signed_at", null),
            validUntil = json.optString("valid_until", null),
            revokedAt = json.optString("revoked_at", null),
            isActive = json.optBoolean("is_active", true),
        )
    }
}
