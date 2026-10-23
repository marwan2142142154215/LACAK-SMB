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
            recordedAt = if (json.isNull("recorded_at")) null else json.optString("recorded_at"),
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
            lastSeenAt = if (json.isNull("last_seen_at")) null else json.optString("last_seen_at"),
            enrolledAt = if (json.isNull("enrolled_at")) null else json.optString("enrolled_at"),
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
            allowedSsid = if (json.isNull("allowed_ssid")) null else json.optString("allowed_ssid"),
            allowedIpCidr = if (json.isNull("allowed_ip_cidr")) null else json.optString("allowed_ip_cidr"),
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
            documentUrl = if (json.isNull("document_url")) null else json.optString("document_url"),
            signedAt = if (json.isNull("signed_at")) null else json.optString("signed_at"),
            validUntil = if (json.isNull("valid_until")) null else json.optString("valid_until"),
            revokedAt = if (json.isNull("revoked_at")) null else json.optString("revoked_at"),
            isActive = json.optBoolean("is_active", true),
        )
    }
}
