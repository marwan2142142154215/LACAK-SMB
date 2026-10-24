<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Middleware\RecordApiActivity;
use App\Http\Responses\ApiResponse;
use App\Models\Organization;
use App\Models\User;
use App\Models\WorkSession;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Spatie\Activitylog\Models\Activity;

/**
 * Menu Log aktivitas: siapa melakukan apa di sistem (lihat
 * RecordApiActivity), bukan log jam kerja. Super admin melihat semua site,
 * Admin Site hanya site-nya sendiri (permission activity-logs.view).
 */
class ActivityLogController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    private const PAGE_SIZE = 50;

    /** Kunci yang tidak pernah ditampilkan isinya di rincian perubahan. */
    private const HIDDEN_FIELDS = '/password|secret|token|recovery|two_factor_secret/i';

    private const SUBJECT_LABELS = [
        'User' => 'Staf',
        'Device' => 'Device',
        'GeofenceRule' => 'Aturan geofence',
        'ConsentDocument' => 'Dokumen consent',
        'Organization' => 'Site',
        'ApkBuild' => 'Build APK',
        'TelegramBinding' => 'Grup Telegram',
        'TelegramUserLink' => 'Tautan Telegram',
        'AppSetting' => 'Pengaturan',
    ];

    private const NAME_ATTRIBUTES = ['username', 'device_name', 'rule_name', 'subject_name', 'name', 'version', 'telegram_chat_id', 'key'];

    public function index(Request $request)
    {
        $user = $request->user();
        $user->can('activity-logs.view') || abort(403);

        $validated = $request->validate([
            'organization_id' => ['nullable', 'integer'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'category' => ['nullable', 'string', 'max:30'],
            'result' => ['nullable', 'in:ok,denied,failed'],
            'search' => ['nullable', 'string', 'max:100'],
            'before_id' => ['nullable', 'integer'],
        ]);

        // Super admin: semua site (atau satu site pilihan). Lainnya: site sendiri saja.
        $requested = $validated['organization_id'] ?? null;
        if ($this->hasCrossOrganizationAccess($user)) {
            $organizationId = $requested;
        } else {
            $organizationId = $this->authorizedOrganizationId($user, $requested);
            if ($organizationId === null) {
                return $this->fail('Anda tidak berwenang melihat log site ini', null, 403);
            }
        }

        $query = Activity::query()
            ->with(['causer', 'subject'])
            // Aksi API + perubahan data di luar permintaan API (mis. perintah
            // server). Perubahan di dalam permintaan tampil sebagai rincian
            // aksinya; sesi kerja punya log sendiri (Aktivitas user).
            ->where(fn (Builder $query) => $query
                ->where('log_name', RecordApiActivity::LOG_NAME)
                ->orWhere(fn (Builder $query) => $query
                    ->whereNull('batch_uuid')
                    ->where(fn (Builder $query) => $query->whereNull('subject_type')->orWhere('subject_type', '!=', WorkSession::class))))
            ->when($organizationId !== null, fn (Builder $query) => $query->where('organization_id', $organizationId))
            ->when($validated['from'] ?? null, fn (Builder $query, $from) => $query->where('created_at', '>=', Carbon::parse($from)))
            ->when($validated['to'] ?? null, fn (Builder $query, $to) => $query->where('created_at', '<=', Carbon::parse($to)))
            ->when($validated['category'] ?? null, fn (Builder $query, $category) => $category === 'data'
                ? $query->where('log_name', '!=', RecordApiActivity::LOG_NAME)
                : $query->where('properties->category', $category))
            ->when($validated['result'] ?? null, fn (Builder $query, $result) => $query->where('properties->result', $result))
            ->when($validated['search'] ?? null, function (Builder $query, string $search) {
                $like = '%'.str_replace(['%', '_'], ['\%', '\_'], mb_strtolower($search)).'%';
                $causerIds = User::withTrashed()
                    ->whereRaw('LOWER(name) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(username) LIKE ?', [$like])
                    ->pluck('id');
                $query->where(fn (Builder $query) => $query
                    ->whereRaw('LOWER(description) LIKE ?', [$like])
                    ->orWhere(fn (Builder $query) => $query->where('causer_type', User::class)->whereIn('causer_id', $causerIds))
                    ->orWhere('ip_address', 'like', $like));
            })
            ->when($validated['before_id'] ?? null, fn (Builder $query, $beforeId) => $query->where('id', '<', $beforeId))
            ->latest('id')
            ->limit(self::PAGE_SIZE);

        $entries = $query->get();
        $changes = $this->batchChanges($entries);
        $siteNames = Organization::withTrashed()->whereIn('id', $entries->pluck('organization_id')->filter()->unique())->pluck('name', 'id');

        return $this->success('Log aktivitas', [
            'entries' => $entries->map(fn (Activity $activity) => $this->payload($activity, $changes, $siteNames))->values(),
            'has_more' => $entries->count() === self::PAGE_SIZE,
        ]);
    }

    /**
     * Perubahan data (sebelum -> sesudah) yang terjadi dalam permintaan
     * yang sama dengan tiap aksi, dikelompokkan per batch_uuid.
     *
     * @return Collection<string, Collection<int, Activity>>
     */
    private function batchChanges(Collection $entries): Collection
    {
        $batches = $entries->where('log_name', RecordApiActivity::LOG_NAME)->pluck('batch_uuid')->filter()->unique();

        return $batches->isEmpty() ? collect() : Activity::query()
            ->with('subject')
            ->whereIn('batch_uuid', $batches)
            ->where('log_name', '!=', RecordApiActivity::LOG_NAME)
            ->orderBy('id')
            ->get()
            ->groupBy('batch_uuid');
    }

    /**
     * @return array<string, mixed>
     */
    private function payload(Activity $activity, Collection $changes, Collection $siteNames): array
    {
        $properties = $activity->properties;
        $isApi = $activity->log_name === RecordApiActivity::LOG_NAME;
        $causer = $activity->causer instanceof User ? $activity->causer : null;
        $related = $isApi ? ($changes[$activity->batch_uuid] ?? collect()) : collect([$activity]);

        return [
            'id' => $activity->id,
            'at' => $activity->created_at?->toIso8601String(),
            'category' => $isApi ? ($properties['category'] ?? 'lainnya') : 'data',
            'description' => $isApi ? $activity->description : $this->dataChangeSentence($activity),
            'result' => $properties['result'] ?? 'ok',
            'status' => $properties['status'] ?? null,
            'message' => $properties['message'] ?? null,
            'causer' => $causer
                ? ['id' => $causer->id, 'name' => $causer->name, 'username' => $causer->username]
                : ($activity->causer_id ? ['id' => $activity->causer_id, 'name' => 'Akun terhapus', 'username' => null] : null),
            'subject' => $activity->subject_type ? [
                'type' => self::SUBJECT_LABELS[class_basename($activity->subject_type)] ?? class_basename($activity->subject_type),
                'name' => $this->subjectName($activity),
            ] : null,
            'organization' => $activity->organization_id
                ? ['id' => $activity->organization_id, 'name' => $siteNames[$activity->organization_id] ?? null]
                : null,
            'ip_address' => $activity->ip_address,
            'device' => $this->deviceLabel($activity->user_agent),
            'user_agent' => $activity->user_agent,
            'route' => $properties['route'] ?? null,
            'input' => $this->safeValues($properties['input'] ?? []),
            'changes' => $related->map(fn (Activity $change) => [
                'type' => self::SUBJECT_LABELS[class_basename((string) $change->subject_type)] ?? class_basename((string) $change->subject_type),
                'name' => $this->subjectName($change),
                'event' => $change->event,
                'fields' => $this->fieldChanges($change),
            ])->filter(fn ($change) => $change['fields'] || $change['event'] !== 'updated')->values(),
        ];
    }

    /**
     * @return list<array{field: string, old: mixed, new: mixed}>
     */
    private function fieldChanges(Activity $activity): array
    {
        $new = $activity->properties['attributes'] ?? [];
        $old = $activity->properties['old'] ?? [];
        $fields = [];
        foreach (array_unique([...array_keys($new), ...array_keys($old)]) as $field) {
            $hidden = preg_match(self::HIDDEN_FIELDS, $field) === 1;
            $fields[] = [
                'field' => $field,
                'old' => $hidden ? '••••' : ($old[$field] ?? null),
                'new' => $hidden ? '••••' : ($new[$field] ?? null),
            ];
        }

        return $fields;
    }

    private function subjectName(Activity $activity): ?string
    {
        $values = [...($activity->properties['old'] ?? []), ...($activity->properties['attributes'] ?? [])];
        foreach (self::NAME_ATTRIBUTES as $attribute) {
            $value = $activity->subject?->getAttribute($attribute) ?? ($values[$attribute] ?? null);
            if (filled($value) && is_scalar($value)) {
                return (string) $value;
            }
        }

        return $activity->subject_id ? "#{$activity->subject_id}" : null;
    }

    private function dataChangeSentence(Activity $activity): string
    {
        if (! in_array($activity->event, ['created', 'updated', 'deleted'], true)) {
            return $activity->description;
        }
        $type = self::SUBJECT_LABELS[class_basename((string) $activity->subject_type)] ?? 'Data';
        $verb = ['created' => 'dibuat', 'updated' => 'diubah', 'deleted' => 'dihapus'][$activity->event];

        return trim("{$type} {$this->subjectName($activity)} {$verb}");
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    private function safeValues(array $values): array
    {
        return collect($values)->reject(fn ($value, $key) => preg_match(self::HIDDEN_FIELDS, (string) $key) === 1)->all();
    }

    /** "Chrome · Windows", "Aplikasi Android", ... -- cukup untuk mengenali dari mana aksi dilakukan. */
    private function deviceLabel(?string $userAgent): ?string
    {
        if (! $userAgent) {
            return null;
        }
        if (preg_match('/okhttp|Dalvik|Ktor/i', $userAgent)) {
            return 'Aplikasi Android';
        }
        if (preg_match('/axios|node|python|curl|Symfony/i', $userAgent)) {
            return 'Server / bot';
        }

        $browser = match (true) {
            str_contains($userAgent, 'Edg/') => 'Edge',
            str_contains($userAgent, 'OPR/') => 'Opera',
            str_contains($userAgent, 'Firefox/') => 'Firefox',
            str_contains($userAgent, 'Chrome/') => 'Chrome',
            str_contains($userAgent, 'Safari/') => 'Safari',
            default => 'Browser',
        };
        $os = match (true) {
            str_contains($userAgent, 'Android') => 'Android',
            (bool) preg_match('/iPhone|iPad/', $userAgent) => 'iOS',
            str_contains($userAgent, 'Windows') => 'Windows',
            str_contains($userAgent, 'Mac OS') => 'macOS',
            str_contains($userAgent, 'Linux') => 'Linux',
            default => null,
        };

        return $os ? "{$browser} · {$os}" : $browser;
    }
}
