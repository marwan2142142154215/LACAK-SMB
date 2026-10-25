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
  }
  POST: {
    'work_sessions.start': { paramsTuple?: []; params?: {} }
    'work_sessions.heartbeat': { paramsTuple?: []; params?: {} }
    'work_sessions.end': { paramsTuple?: []; params?: {} }
    'work_sessions.watch_token': { paramsTuple?: []; params?: {} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}