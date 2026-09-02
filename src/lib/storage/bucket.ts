import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

/**
 * Minimal R2Bucket-compatible surface over any S3 endpoint.
 * We point it at Supabase Storage's S3 gateway (which supascale backs with Cloudflare R2),
 * so the rest of the app keeps calling BUCKET.get / put / delete exactly as before.
 */
export type StorageObjectBody =
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| string
	| ReadableStream<Uint8Array>
	| Uint8Array;

export type StoragePutOptions = {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
};

export type StorageGetOptions = {
	range?: { offset: number; length?: number };
};

export type StorageObject = {
	key: string;
	size: number;
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
	body: ReadableStream<Uint8Array> | null;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
};

export type StorageBucketConfig = {
	endpoint: string;
	region?: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle?: boolean;
};

type SdkBody = {
	transformToByteArray(): Promise<Uint8Array>;
	transformToWebStream(): ReadableStream<Uint8Array>;
};

export class StorageBucket {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: StorageBucketConfig) {
		this.bucket = config.bucket;
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: config.region ?? "auto",
			forcePathStyle: config.forcePathStyle ?? true,
			credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
		});
	}

	async put(key: string, value: StorageObjectBody, options?: StoragePutOptions): Promise<void> {
		const body = await toBytes(value);
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: body,
				ContentType: options?.httpMetadata?.contentType,
				Metadata: options?.customMetadata,
			}),
		);
	}

	async get(key: string, options?: StorageGetOptions): Promise<StorageObject | null> {
		try {
			let range: string | undefined;
			if (options?.range) {
				const { offset, length } = options.range;
				const end = length ? offset + length - 1 : "";
				range = `bytes=${offset}-${end}`;
			}
			const result = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
			);
			const stream = result.Body as SdkBody | undefined;
			if (!stream) return null;
			let cached: Uint8Array | undefined;
			const bytes = async () => (cached ??= await stream.transformToByteArray());
			return {
				key,
				// For ranged reads ContentLength is the range size; the total is in Content-Range.
				size: Number(result.ContentRange?.split("/")[1]) || result.ContentLength || 0,
				httpMetadata: { contentType: result.ContentType },
				customMetadata: result.Metadata,
				get body() {
					return stream.transformToWebStream();
				},
				arrayBuffer: async () => {
					const b = await bytes();
					return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
				},
				text: async () => new TextDecoder().decode(await bytes()),
			};
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async head(key: string): Promise<{ size: number; contentType?: string } | null> {
		try {
			const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
			return { size: result.ContentLength ?? 0, contentType: result.ContentType };
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		await Promise.all(
			keys.map((k) =>
				this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k })).catch((error) => {
					if (!isNotFound(error)) throw error;
				}),
			),
		);
	}
}

function isNotFound(error: unknown): boolean {
	const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

async function toBytes(value: StorageObjectBody): Promise<Uint8Array> {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	return new Uint8Array(await new Response(value).arrayBuffer());
}
