<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\Models\Role;

class RolesAndPermissionsSeeder extends Seeder
{
    /**
     * Role & permission dasar sistem. Pecahan permission yang lebih rinci
     * (per-site scoping, dsb.) ditambah bertahap saat modul terkait dibangun.
     */
    public function run(): void
    {
        $permissions = [
            'organizations.manage',
            'users.manage',
            'devices.view',
            'devices.manage',
            'devices.lock',
            'devices.unlock',
            'devices.locate',
            'devices.monitor',
            'consent-documents.manage',
            'geofence-rules.manage',
            'apk-builds.manage',
            'telegram.manage',
            'activity-logs.view',
        ];

        foreach ($permissions as $permission) {
            Permission::firstOrCreate(['name' => $permission, 'guard_name' => 'web']);
        }

        $superAdmin = Role::firstOrCreate(['name' => 'super_admin', 'guard_name' => 'web']);
        $superAdmin->syncPermissions($permissions);

        $siteAdmin = Role::firstOrCreate(['name' => 'site_admin', 'guard_name' => 'web']);
        $siteAdmin->syncPermissions([
            'devices.view',
            'devices.manage',
            'devices.lock',
            'devices.unlock',
            'devices.locate',
            'devices.monitor',
            'consent-documents.manage',
            'geofence-rules.manage',
            'apk-builds.manage',
            'telegram.manage',
            'activity-logs.view',
        ]);

        $parent = Role::firstOrCreate(['name' => 'parent', 'guard_name' => 'web']);
        $parent->syncPermissions([
            'devices.view',
            'devices.lock',
            'devices.unlock',
            'devices.locate',
        ]);

        $staffViewer = Role::firstOrCreate(['name' => 'staff_viewer', 'guard_name' => 'web']);
        $staffViewer->syncPermissions([
            'devices.view',
        ]);
    }
}
