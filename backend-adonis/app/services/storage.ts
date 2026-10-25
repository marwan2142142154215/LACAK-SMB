import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import type { Readable } from 'node:stream'
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import env from '#start/env'

/**
 * Disk penyimpanan file yang SAMA dengan backend-api (config/filesystems.php):
 *
 * - "local"  = storage/app/private milik backend-api (LARAVEL_STORAGE_PATH),
 *              jadi file lama tetap terbaca dan file baru terbaca Laravel.
 * - "spaces" = DigitalOcean Spaces (S3), kredensial DO_SPACES_*.
 *
 * Path selalu relatif terhadap akar disk, sama dengan kolom file_path di DB.
 */
export type DiskName = 'local' | 'spaces'

export interface Disk {
    put(path: string, contents: Buffer | string, contentType?: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** Stream isi file + ukurannya (byte), atau null kalau tidak ada. */
    read(path: string): Promise<{ stream: Readable; size: number | null } | null>
    delete(path: string): Promise<void>
    /**
     * Storage::disk()->temporaryUrl(): tautan bertanda waktu milik penyimpanan
     * itu sendiri. Hanya Spaces yang mendukung; disk lokal melempar error
     * (sama dengan Laravel: driver local tanpa serve tidak punya temporaryUrl).
     */
    temporaryUrl(path: string, options: TemporaryUrlOptions): Promise<string>
}

export type TemporaryUrlOptions = {
    expiresInSeconds: number
    responseContentDisposition?: string
    responseContentType?: string
}

class LocalDisk implements Disk {
    constructor(private readonly root: string) {}

    /** Tolak path yang keluar dari akar disk (../). */
    private resolve(path: string): string {
        const full = normalize(join(this.root, path))
        if (full !== normalize(this.root) && !full.startsWith(normalize(this.root) + sep)) {
            throw new Error(`Path di luar disk: ${path}`)
        }
        return full
    }

    async put(path: string, contents: Buffer | string) {
        const full = this.resolve(path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, contents)
    }

    async exists(path: string) {
        try {
            const info = await stat(this.resolve(path))
            return info.isFile()
        } catch {
            return false
        }
    }

    async read(path: string) {
        const full = this.resolve(path)
        try {
            const info = await stat(full)
            if (!info.isFile()) return null
            return { stream: createReadStream(full), size: info.size }
        } catch {
            return null
        }
    }

    async delete(path: string) {
        await rm(this.resolve(path), { force: true })
    }

    async temporaryUrl(): Promise<string> {
        throw new Error('Disk local tidak mendukung temporaryUrl()')
    }
}

class SpacesDisk implements Disk {
    private readonly client: S3Client
    private readonly bucket: string

    constructor() {
        const region = env.get('DO_SPACES_REGION') || 'sgp1'
        this.bucket = env.get('DO_SPACES_BUCKET') ?? ''
        this.client = new S3Client({
            region,
            endpoint: env.get('DO_SPACES_ENDPOINT') || `https://${region}.digitaloceanspaces.com`,
            credentials: {
                accessKeyId: env.get('DO_SPACES_KEY') ?? '',
                secretAccessKey: env.get('DO_SPACES_SECRET')?.release() ?? '',
            },
        })
    }

    async put(path: string, contents: Buffer | string, contentType?: string) {
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: path,
                Body: contents,
                ACL: 'private',
                ContentType: contentType,
            })
        )
    }

    async exists(path: string) {
        try {
            await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }))
            return true
        } catch {
            return false
        }
    }

    async read(path: string) {
        try {
            const object = await this.client.send(
                new GetObjectCommand({ Bucket: this.bucket, Key: path })
            )
            return { stream: object.Body as Readable, size: object.ContentLength ?? null }
        } catch {
            return null
        }
    }

    async delete(path: string) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }))
    }

    async temporaryUrl(path: string, options: TemporaryUrlOptions) {
        return getSignedUrl(
            this.client,
            new GetObjectCommand({
                Bucket: this.bucket,
                Key: path,
                ResponseContentDisposition: options.responseContentDisposition,
                ResponseContentType: options.responseContentType,
            }),
            { expiresIn: options.expiresInSeconds }
        )
    }
}

const disks = new Map<DiskName, Disk>()

export function disk(name: DiskName): Disk {
    let instance = disks.get(name)
    if (!instance) {
        instance =
            name === 'spaces'
                ? new SpacesDisk()
                : new LocalDisk(
                      env.get('LARAVEL_STORAGE_PATH') ??
                          join(process.cwd(), 'storage', 'app', 'private')
                  )
        disks.set(name, instance)
    }
    return instance
}

/** filesystems.documents_disk: dokumen consent & berkas APK. */
export const documentsDiskName = (): DiskName => env.get('DOCUMENTS_DISK') ?? 'spaces'

/** filesystems.chat_images_disk: gambar chat staf. */
export const chatImagesDiskName = (): DiskName => env.get('CHAT_IMAGES_DISK') ?? 'local'
