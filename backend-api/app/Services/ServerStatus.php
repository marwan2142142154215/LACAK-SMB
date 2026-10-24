<?php

namespace App\Services;

use App\Models\ApkBuild;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Throwable;

/**
 * Pemeriksaan kesehatan semua layanan Lacak SMB untuk halaman "Status
 * server" (super_admin). Tiap layanan dicek dengan cara yang benar-benar
 * membuktikan ia bekerja, bukan sekadar prosesnya hidup:
 * database & cache = query/tulis-baca nyata, scheduler & antrean = detak
 * yang ditulis tiap menit oleh scheduler dan oleh queue worker,
 * gateway & LiveKit = permintaan HTTP ke layanannya.
 */
class ServerStatus
{
    public const OK = 'ok';

    public const WARN = 'warn';

    public const DOWN = 'down';

    public const UNKNOWN = 'unknown';

    public const SCHEDULER_HEARTBEAT_KEY = 'server-status:scheduler-heartbeat';

    public const QUEUE_HEARTBEAT_KEY = 'server-status:queue-heartbeat';

    /** Detak ditulis tiap menit — lewat dari ini dianggap terlambat / mati. */
    private const HEARTBEAT_WARN_SECONDS = 150;

    private const HEARTBEAT_DOWN_SECONDS = 600;

    private const HTTP_TIMEOUT_SECONDS = 3;

    /**
     * @return array{checked_at: string, overall: string, services: list<array<string, mixed>>, units: list<array<string, mixed>>, system: array<string, mixed>}
     */
    public function snapshot(): array
    {
        $services = [
            $this->api(),
            $this->database(),
            $this->cache(),
            $this->scheduler(),
            $this->queue(),
            ...$this->httpServices(),
            $this->storage(),
        ];

        $statuses = array_column($services, 'status');

        return [
            'checked_at' => now()->toIso8601String(),
            'overall' => match (true) {
                in_array(self::DOWN, $statuses, true) => self::DOWN,
                in_array(self::WARN, $statuses, true) => self::WARN,
                default => self::OK,
            },
            'services' => $services,
            'units' => $this->systemdUnits(),
            'system' => $this->system(),
        ];
    }

    /** Dipanggil scheduler tiap menit (routes/console.php). */
    public static function recordSchedulerHeartbeat(): void
    {
        Cache::forever(self::SCHEDULER_HEARTBEAT_KEY, now()->toIso8601String());
    }

    /** Dipanggil RecordQueueHeartbeat — membuktikan queue worker memproses job. */
    public static function recordQueueHeartbeat(): void
    {
        Cache::forever(self::QUEUE_HEARTBEAT_KEY, now()->toIso8601String());
    }

    /**
     * @return array<string, mixed>
     */
    private function api(): array
    {
        return $this->service('api', 'API backend', self::OK, 'PHP '.PHP_VERSION.' · Laravel '.app()->version(), 0);
    }

    /**
     * @return array<string, mixed>
     */
    private function database(): array
    {
        $started = microtime(true);
        try {
            $version = DB::connection()->getDriverName() === 'pgsql'
                ? 'PostgreSQL '.explode(' ', (string) DB::scalar('show server_version'))[0]
                : DB::connection()->getDriverName();
            DB::select('select 1');

            return $this->service('database', 'Database', self::OK, $version, $this->elapsed($started));
        } catch (Throwable) {
            return $this->service('database', 'Database', self::DOWN, 'Tidak bisa terhubung ke database', $this->elapsed($started));
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function cache(): array
    {
        $started = microtime(true);
        try {
            $token = bin2hex(random_bytes(4));
            Cache::put('server-status:probe', $token, 30);
            $ok = Cache::get('server-status:probe') === $token;

            return $this->service('cache', 'Cache', $ok ? self::OK : self::DOWN, 'Driver '.config('cache.default'), $this->elapsed($started));
        } catch (Throwable) {
            return $this->service('cache', 'Cache', self::DOWN, 'Cache tidak bisa ditulis/dibaca', $this->elapsed($started));
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function scheduler(): array
    {
        $lastSeen = $this->heartbeat(self::SCHEDULER_HEARTBEAT_KEY);
        $status = $this->heartbeatStatus($lastSeen);

        return $this->service('scheduler', 'Scheduler (tugas tiap menit)', $status, match ($status) {
            self::OK => 'Berjalan — menutup sesi Live Kerja yang terputus',
            self::UNKNOWN => 'Belum pernah berjalan. Pastikan layanan lacak-scheduler aktif.',
            default => 'Terlambat — sesi Live Kerja yang putus tidak ditutup otomatis',
        }, null, $lastSeen);
    }

    /**
     * @return array<string, mixed>
     */
    private function queue(): array
    {
        $lastSeen = $this->heartbeat(self::QUEUE_HEARTBEAT_KEY);
        $status = $this->heartbeatStatus($lastSeen);

        try {
            $pending = DB::table(config('queue.connections.database.table', 'jobs'))->count();
            $failed = DB::table(config('queue.failed.table', 'failed_jobs'))->count();
        } catch (Throwable) {
            $pending = $failed = null;
        }
        // Worker memproses satu job sekali jalan; build APK bisa makan
        // beberapa menit dan menunda detaknya — itu bukan worker mati.
        $building = ApkBuild::query()->where('status', 'building')->exists();
        if ($status !== self::OK && $building) {
            $status = self::WARN;
        }

        $detail = match (true) {
            $status === self::UNKNOWN => 'Belum ada job yang diproses. Pastikan layanan lacak-queue dan lacak-scheduler aktif.',
            $status !== self::OK && $building => 'Sedang memproses build APK — job lain menunggu',
            $status === self::OK => 'Worker memproses job',
            default => 'Worker tidak memproses job — build APK tidak akan jalan',
        };
        if ($pending !== null) {
            $detail .= " · {$pending} menunggu · {$failed} gagal";
        }

        return $this->service('queue', 'Antrean (queue worker)', $status, $detail, null, $lastSeen);
    }

    /**
     * Gateway realtime (chat, device, radar) & LiveKit (siaran) dicek
     * bersamaan supaya halaman tidak menunggu dua kali timeout.
     *
     * @return list<array<string, mixed>>
     */
    private function httpServices(): array
    {
        $targets = [
            'gateway' => ['Gateway realtime (chat, device, radar)', config('lacaksmb.status.gateway_url')],
            'livekit' => ['LiveKit (siaran Live Kerja)', config('lacaksmb.status.livekit_url') ?: $this->livekitHttpUrl()],
        ];

        $responses = Http::pool(fn (Pool $pool) => collect($targets)
            ->filter(fn ($target) => filled($target[1]))
            ->map(fn ($target, $key) => $pool->as($key)->timeout(self::HTTP_TIMEOUT_SECONDS)->connectTimeout(self::HTTP_TIMEOUT_SECONDS)->get($target[1]))
            ->values()
            ->all());

        $results = [];
        foreach ($targets as $key => [$name, $url]) {
            $response = $responses[$key] ?? null;
            if (! filled($url)) {
                $results[] = $this->service($key, $name, self::UNKNOWN, 'Alamat pemeriksaan belum diatur', null);

                continue;
            }
            if (! $response instanceof Response) {
                $results[] = $this->service($key, $name, self::DOWN, 'Tidak menjawab dalam '.self::HTTP_TIMEOUT_SECONDS.' detik', null);

                continue;
            }
            $ok = $response->successful() && ($key !== 'gateway' || $response->json('data.status') === 'ok');
            $latency = (int) round(($response->handlerStats()['total_time'] ?? 0) * 1000);
            $results[] = $this->service($key, $name, $ok ? self::OK : self::DOWN, $ok ? 'Menjawab normal' : 'Menjawab dengan error HTTP '.$response->status(), $latency);
        }

        return $results;
    }

    /**
     * @return array<string, mixed>
     */
    private function storage(): array
    {
        $total = @disk_total_space(base_path());
        $free = @disk_free_space(base_path());
        if (! $total || $free === false) {
            return $this->service('storage', 'Penyimpanan disk', self::UNKNOWN, 'Ukuran disk tidak terbaca', null);
        }

        $freeRatio = $free / $total;
        $status = match (true) {
            $freeRatio < 0.03 => self::DOWN,
            $freeRatio < 0.10 => self::WARN,
            default => self::OK,
        };

        return $this->service('storage', 'Penyimpanan disk', $status, sprintf('Sisa %s dari %s (%d%%)', $this->bytes($free), $this->bytes($total), round($freeRatio * 100)), null);
    }

    /**
     * Status unit systemd di server Linux (lacak-gateway, lacak-queue, ...).
     * Daftar unit dari config, bukan dari input — aman dijalankan.
     *
     * @return list<array{name: string, status: string, state: string}>
     */
    private function systemdUnits(): array
    {
        $units = array_values(array_filter(array_map('trim', explode(',', (string) config('lacaksmb.status.systemd_units')))));
        if (! $units || PHP_OS_FAMILY !== 'Linux') {
            return [];
        }

        try {
            $result = Process::timeout(5)->run(['systemctl', 'is-active', ...$units]);
            $states = preg_split('/\R/', trim($result->output()));
        } catch (Throwable) {
            $states = [];
        }

        return array_map(fn (string $unit, int $index) => [
            'name' => $unit,
            'state' => $states[$index] ?? 'unknown',
            'status' => match ($states[$index] ?? 'unknown') {
                'active' => self::OK,
                'activating', 'reloading', 'deactivating' => self::WARN,
                'inactive', 'failed' => self::DOWN,
                default => self::UNKNOWN,
            },
        ], $units, array_keys($units));
    }

    /**
     * @return array<string, mixed>
     */
    private function system(): array
    {
        $memory = null;
        $uptime = null;
        if (is_readable('/proc/meminfo')) {
            preg_match_all('/^(MemTotal|MemAvailable):\s+(\d+) kB/m', (string) file_get_contents('/proc/meminfo'), $matches, PREG_SET_ORDER);
            $values = collect($matches)->mapWithKeys(fn ($match) => [$match[1] => (int) $match[2] * 1024]);
            if ($values->has(['MemTotal', 'MemAvailable'])) {
                $memory = ['total' => $values['MemTotal'], 'used' => $values['MemTotal'] - $values['MemAvailable']];
            }
        }
        if (is_readable('/proc/uptime')) {
            $uptime = (int) explode(' ', (string) file_get_contents('/proc/uptime'))[0];
        }

        return [
            'hostname' => gethostname() ?: null,
            'os' => PHP_OS_FAMILY,
            'environment' => app()->environment(),
            'timezone' => config('app.timezone'),
            'load' => function_exists('sys_getloadavg') ? (sys_getloadavg() ?: null) : null,
            'cpu_count' => $this->cpuCount(),
            'memory' => $memory,
            'uptime_seconds' => $uptime,
        ];
    }

    private function cpuCount(): ?int
    {
        if (is_readable('/proc/cpuinfo')) {
            return preg_match_all('/^processor\s*:/m', (string) file_get_contents('/proc/cpuinfo')) ?: null;
        }

        return null;
    }

    private function livekitHttpUrl(): ?string
    {
        $url = config('lacaksmb.livekit.url');

        return $url ? preg_replace('#^ws(s?)://#', 'http$1://', $url) : null;
    }

    private function heartbeat(string $key): ?string
    {
        try {
            return Cache::get($key);
        } catch (Throwable) {
            return null;
        }
    }

    private function heartbeatStatus(?string $lastSeen): string
    {
        if (! $lastSeen) {
            return self::UNKNOWN;
        }
        $age = Carbon::parse($lastSeen)->diffInSeconds(now(), true);

        return match (true) {
            $age <= self::HEARTBEAT_WARN_SECONDS => self::OK,
            $age <= self::HEARTBEAT_DOWN_SECONDS => self::WARN,
            default => self::DOWN,
        };
    }

    /**
     * @return array{key: string, name: string, status: string, detail: string, latency_ms: ?int, last_seen_at: ?string}
     */
    private function service(string $key, string $name, string $status, string $detail, ?int $latencyMs, ?string $lastSeen = null): array
    {
        return ['key' => $key, 'name' => $name, 'status' => $status, 'detail' => $detail, 'latency_ms' => $latencyMs, 'last_seen_at' => $lastSeen];
    }

    private function elapsed(float $started): int
    {
        return (int) round((microtime(true) - $started) * 1000);
    }

    private function bytes(float|int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $power = $bytes > 0 ? min((int) floor(log($bytes, 1024)), count($units) - 1) : 0;

        return round($bytes / (1024 ** $power), 1).' '.$units[$power];
    }
}
