/* eslint-disable prettier/prettier */
import type { AdonisEndpoint } from '@tuyau/core/types'
import type { Registry } from './schema.d.ts'
import type { ApiDefinition } from './tree.d.ts'

const placeholder: any = {}

const routes = {
  'auth.new_account.store': {
    methods: ["POST"],
    pattern: '/_unused_starter_kit_auth/auth/signup',
    tokens: [{"old":"/_unused_starter_kit_auth/auth/signup","type":0,"val":"_unused_starter_kit_auth","end":""},{"old":"/_unused_starter_kit_auth/auth/signup","type":0,"val":"auth","end":""},{"old":"/_unused_starter_kit_auth/auth/signup","type":0,"val":"signup","end":""}],
    types: placeholder as Registry['auth.new_account.store']['types'],
  },
  'auth.access_tokens.store': {
    methods: ["POST"],
    pattern: '/_unused_starter_kit_auth/auth/login',
    tokens: [{"old":"/_unused_starter_kit_auth/auth/login","type":0,"val":"_unused_starter_kit_auth","end":""},{"old":"/_unused_starter_kit_auth/auth/login","type":0,"val":"auth","end":""},{"old":"/_unused_starter_kit_auth/auth/login","type":0,"val":"login","end":""}],
    types: placeholder as Registry['auth.access_tokens.store']['types'],
  },
  'profile.profile.show': {
    methods: ["GET","HEAD"],
    pattern: '/_unused_starter_kit_auth/account/profile',
    tokens: [{"old":"/_unused_starter_kit_auth/account/profile","type":0,"val":"_unused_starter_kit_auth","end":""},{"old":"/_unused_starter_kit_auth/account/profile","type":0,"val":"account","end":""},{"old":"/_unused_starter_kit_auth/account/profile","type":0,"val":"profile","end":""}],
    types: placeholder as Registry['profile.profile.show']['types'],
  },
  'profile.access_tokens.destroy': {
    methods: ["POST"],
    pattern: '/_unused_starter_kit_auth/account/logout',
    tokens: [{"old":"/_unused_starter_kit_auth/account/logout","type":0,"val":"_unused_starter_kit_auth","end":""},{"old":"/_unused_starter_kit_auth/account/logout","type":0,"val":"account","end":""},{"old":"/_unused_starter_kit_auth/account/logout","type":0,"val":"logout","end":""}],
    types: placeholder as Registry['profile.access_tokens.destroy']['types'],
  },
} as const satisfies Record<string, AdonisEndpoint>

export { routes }

export const registry = {
  routes,
  $tree: {} as ApiDefinition,
}

declare module '@tuyau/core/types' {
  export interface UserRegistry {
    routes: typeof routes
    $tree: ApiDefinition
  }
}
