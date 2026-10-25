import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'auth.me': { paramsTuple?: []; params?: {} }
    'auth.session': { paramsTuple?: []; params?: {} }
    'dashboard_summary.show': { paramsTuple?: []; params?: {} }
    'work_sessions.sites': { paramsTuple?: []; params?: {} }
    'work_sessions.index': { paramsTuple?: []; params?: {} }
    'work_sessions.overview': { paramsTuple?: []; params?: {} }
    'work_sessions.start': { paramsTuple?: []; params?: {} }
    'work_sessions.heartbeat': { paramsTuple?: []; params?: {} }
    'work_sessions.end': { paramsTuple?: []; params?: {} }
    'work_sessions.app': { paramsTuple?: []; params?: {} }
    'work_sessions.activity': { paramsTuple?: []; params?: {} }
    'work_sessions.watch_token': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'auth.confirm_two_factor_setup': { paramsTuple?: []; params?: {} }
    'auth.verify_two_factor': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'organizations.index': { paramsTuple?: []; params?: {} }
    'organizations.store': { paramsTuple?: []; params?: {} }
    'organizations.show': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'organizations.update': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'organizations.destroy': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.index': { paramsTuple?: []; params?: {} }
    'users.store': { paramsTuple?: []; params?: {} }
    'users.show': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.update': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.destroy': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.suspend': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.reactivate': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.reset_2_fa': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.sync_site_access': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'security_settings.show': { paramsTuple?: []; params?: {} }
    'security_settings.update': { paramsTuple?: []; params?: {} }
    'device_otp.verify': { paramsTuple?: []; params?: {} }
    'device_enrollment.claim': { paramsTuple?: []; params?: {} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.store': { paramsTuple?: []; params?: {} }
    'devices.show': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'devices.update': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'devices.destroy': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_commands.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_commands.store': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_otp.generate': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_enrollment.re_enroll': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'violation_logs.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'consent_documents.download': { paramsTuple: [ParamValue]; params: {'consentDocument': ParamValue} }
    'consent_documents.index': { paramsTuple?: []; params?: {} }
    'consent_documents.store': { paramsTuple?: []; params?: {} }
    'consent_documents.show': { paramsTuple: [ParamValue]; params: {'consent_document': ParamValue} }
    'consent_documents.revoke': { paramsTuple: [ParamValue]; params: {'consentDocument': ParamValue} }
    'geofence_rules.index': { paramsTuple?: []; params?: {} }
    'geofence_rules.store': { paramsTuple?: []; params?: {} }
    'geofence_rules.update': { paramsTuple: [ParamValue]; params: {'geofence_rule': ParamValue} }
    'geofence_rules.destroy': { paramsTuple: [ParamValue]; params: {'geofence_rule': ParamValue} }
    'telegram_bindings.index': { paramsTuple?: []; params?: {} }
    'telegram_bindings.store': { paramsTuple?: []; params?: {} }
    'telegram_bindings.lookup': { paramsTuple?: []; params?: {} }
    'telegram_bindings.destroy': { paramsTuple: [ParamValue]; params: {'telegram_binding': ParamValue} }
    'telegram_user_links.index': { paramsTuple?: []; params?: {} }
    'telegram_user_links.store': { paramsTuple?: []; params?: {} }
    'telegram_user_links.lookup': { paramsTuple?: []; params?: {} }
    'telegram_user_links.destroy': { paramsTuple: [ParamValue]; params: {'telegram_user_link': ParamValue} }
    'chat_messages.image': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'chat_messages.index': { paramsTuple?: []; params?: {} }
    'chat_messages.store': { paramsTuple?: []; params?: {} }
    'chat_messages.show': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'activity_logs.index': { paramsTuple?: []; params?: {} }
    'system_status': { paramsTuple?: []; params?: {} }
    'apk_builds.download': { paramsTuple: [ParamValue]; params: {'apkBuild': ParamValue} }
    'apk_builds.index': { paramsTuple?: []; params?: {} }
    'apk_builds.store': { paramsTuple?: []; params?: {} }
    'apk_builds.generate': { paramsTuple?: []; params?: {} }
    'apk_builds.show': { paramsTuple: [ParamValue]; params: {'apk_build': ParamValue} }
    'apk_builds.destroy': { paramsTuple: [ParamValue]; params: {'apk_build': ParamValue} }
  }
  GET: {
    'auth.me': { paramsTuple?: []; params?: {} }
    'auth.session': { paramsTuple?: []; params?: {} }
    'dashboard_summary.show': { paramsTuple?: []; params?: {} }
    'work_sessions.sites': { paramsTuple?: []; params?: {} }
    'work_sessions.index': { paramsTuple?: []; params?: {} }
    'work_sessions.overview': { paramsTuple?: []; params?: {} }
    'work_sessions.app': { paramsTuple?: []; params?: {} }
    'work_sessions.activity': { paramsTuple?: []; params?: {} }
    'organizations.index': { paramsTuple?: []; params?: {} }
    'organizations.show': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.index': { paramsTuple?: []; params?: {} }
    'users.show': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'security_settings.show': { paramsTuple?: []; params?: {} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.show': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_commands.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'violation_logs.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'consent_documents.download': { paramsTuple: [ParamValue]; params: {'consentDocument': ParamValue} }
    'consent_documents.index': { paramsTuple?: []; params?: {} }
    'consent_documents.show': { paramsTuple: [ParamValue]; params: {'consent_document': ParamValue} }
    'geofence_rules.index': { paramsTuple?: []; params?: {} }
    'telegram_bindings.index': { paramsTuple?: []; params?: {} }
    'telegram_bindings.lookup': { paramsTuple?: []; params?: {} }
    'telegram_user_links.index': { paramsTuple?: []; params?: {} }
    'telegram_user_links.lookup': { paramsTuple?: []; params?: {} }
    'chat_messages.image': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'chat_messages.index': { paramsTuple?: []; params?: {} }
    'chat_messages.show': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'activity_logs.index': { paramsTuple?: []; params?: {} }
    'system_status': { paramsTuple?: []; params?: {} }
    'apk_builds.download': { paramsTuple: [ParamValue]; params: {'apkBuild': ParamValue} }
    'apk_builds.index': { paramsTuple?: []; params?: {} }
    'apk_builds.show': { paramsTuple: [ParamValue]; params: {'apk_build': ParamValue} }
  }
  HEAD: {
    'auth.me': { paramsTuple?: []; params?: {} }
    'auth.session': { paramsTuple?: []; params?: {} }
    'dashboard_summary.show': { paramsTuple?: []; params?: {} }
    'work_sessions.sites': { paramsTuple?: []; params?: {} }
    'work_sessions.index': { paramsTuple?: []; params?: {} }
    'work_sessions.overview': { paramsTuple?: []; params?: {} }
    'work_sessions.app': { paramsTuple?: []; params?: {} }
    'work_sessions.activity': { paramsTuple?: []; params?: {} }
    'organizations.index': { paramsTuple?: []; params?: {} }
    'organizations.show': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.index': { paramsTuple?: []; params?: {} }
    'users.show': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'security_settings.show': { paramsTuple?: []; params?: {} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.show': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_commands.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'violation_logs.index': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'consent_documents.download': { paramsTuple: [ParamValue]; params: {'consentDocument': ParamValue} }
    'consent_documents.index': { paramsTuple?: []; params?: {} }
    'consent_documents.show': { paramsTuple: [ParamValue]; params: {'consent_document': ParamValue} }
    'geofence_rules.index': { paramsTuple?: []; params?: {} }
    'telegram_bindings.index': { paramsTuple?: []; params?: {} }
    'telegram_bindings.lookup': { paramsTuple?: []; params?: {} }
    'telegram_user_links.index': { paramsTuple?: []; params?: {} }
    'telegram_user_links.lookup': { paramsTuple?: []; params?: {} }
    'chat_messages.image': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'chat_messages.index': { paramsTuple?: []; params?: {} }
    'chat_messages.show': { paramsTuple: [ParamValue]; params: {'chatMessage': ParamValue} }
    'activity_logs.index': { paramsTuple?: []; params?: {} }
    'system_status': { paramsTuple?: []; params?: {} }
    'apk_builds.download': { paramsTuple: [ParamValue]; params: {'apkBuild': ParamValue} }
    'apk_builds.index': { paramsTuple?: []; params?: {} }
    'apk_builds.show': { paramsTuple: [ParamValue]; params: {'apk_build': ParamValue} }
  }
  POST: {
    'work_sessions.start': { paramsTuple?: []; params?: {} }
    'work_sessions.heartbeat': { paramsTuple?: []; params?: {} }
    'work_sessions.end': { paramsTuple?: []; params?: {} }
    'work_sessions.watch_token': { paramsTuple?: []; params?: {} }
    'auth.login': { paramsTuple?: []; params?: {} }
    'auth.confirm_two_factor_setup': { paramsTuple?: []; params?: {} }
    'auth.verify_two_factor': { paramsTuple?: []; params?: {} }
    'auth.logout': { paramsTuple?: []; params?: {} }
    'organizations.store': { paramsTuple?: []; params?: {} }
    'users.store': { paramsTuple?: []; params?: {} }
    'users.suspend': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.reactivate': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.reset_2_fa': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'device_otp.verify': { paramsTuple?: []; params?: {} }
    'device_enrollment.claim': { paramsTuple?: []; params?: {} }
    'devices.store': { paramsTuple?: []; params?: {} }
    'device_commands.store': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_otp.generate': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'device_enrollment.re_enroll': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'consent_documents.store': { paramsTuple?: []; params?: {} }
    'consent_documents.revoke': { paramsTuple: [ParamValue]; params: {'consentDocument': ParamValue} }
    'geofence_rules.store': { paramsTuple?: []; params?: {} }
    'telegram_bindings.store': { paramsTuple?: []; params?: {} }
    'telegram_user_links.store': { paramsTuple?: []; params?: {} }
    'chat_messages.store': { paramsTuple?: []; params?: {} }
    'apk_builds.store': { paramsTuple?: []; params?: {} }
    'apk_builds.generate': { paramsTuple?: []; params?: {} }
  }
  PUT: {
    'organizations.update': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.update': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'users.sync_site_access': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'security_settings.update': { paramsTuple?: []; params?: {} }
    'devices.update': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'geofence_rules.update': { paramsTuple: [ParamValue]; params: {'geofence_rule': ParamValue} }
  }
  PATCH: {
    'organizations.update': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.update': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'devices.update': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'geofence_rules.update': { paramsTuple: [ParamValue]; params: {'geofence_rule': ParamValue} }
  }
  DELETE: {
    'organizations.destroy': { paramsTuple: [ParamValue]; params: {'organization': ParamValue} }
    'users.destroy': { paramsTuple: [ParamValue]; params: {'user': ParamValue} }
    'devices.destroy': { paramsTuple: [ParamValue]; params: {'device': ParamValue} }
    'geofence_rules.destroy': { paramsTuple: [ParamValue]; params: {'geofence_rule': ParamValue} }
    'telegram_bindings.destroy': { paramsTuple: [ParamValue]; params: {'telegram_binding': ParamValue} }
    'telegram_user_links.destroy': { paramsTuple: [ParamValue]; params: {'telegram_user_link': ParamValue} }
    'apk_builds.destroy': { paramsTuple: [ParamValue]; params: {'apk_build': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}