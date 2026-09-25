import { z } from 'zod';
import { findErrorCode, registryCatalog } from '../registry';

export const FieldErrorSchema = z.strictObject({
  path: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const ProblemDetailsSchema = z.strictObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1),
  instance: z.string().min(1),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  permittedActions: z.array(z.string().min(1)),
  fieldErrors: z.array(FieldErrorSchema).optional(),
  retryable: z.boolean(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ErrorCode = (typeof registryCatalog.baseErrors)[number]['code']
  | (typeof registryCatalog.domainErrors)[number]['code'];

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly permittedActions: string[] = [],
    readonly fieldErrors?: FieldError[],
  ) {
    super(code);
    this.name = 'DomainError';
    if (!findErrorCode(code)) throw new Error(`Unregistered error code: ${code}`);
  }
}

/** A request-shape error is HTTP 400; domain validation keeps Appendix F's HTTP 422. */
export class MalformedRequestError extends DomainError {
  constructor(fieldErrors: FieldError[]) {
    super('VALIDATION_FAILED', [], fieldErrors);
    this.name = 'MalformedRequestError';
  }
}

const internalCopy = { title: 'Terjadi kendala', message: 'Coba lagi sebentar lagi.' };
const baseCopy: Record<string, { title: string; message: string }> = {
  INTERNAL: internalCopy,
  VALIDATION_FAILED: { title: 'Data belum sesuai', message: 'Periksa kembali data yang diisi.' },
  UNAUTHENTICATED: { title: 'Sesi berakhir', message: 'Masuk kembali untuk melanjutkan.' },
  PERMISSION_DENIED: { title: 'Akses tidak tersedia', message: 'Hubungi admin jika Anda memerlukan akses.' },
  NOT_FOUND: { title: 'Data tidak ditemukan', message: 'Periksa tautan atau kembali ke daftar.' },
  STALE_DATA: { title: 'Data sudah berubah', message: 'Muat ulang data sebelum melanjutkan.' },
  INVALID_STATE_TRANSITION: { title: 'Tindakan belum bisa dilakukan', message: 'Pilih tindakan yang tersedia.' },
  IDEMPOTENCY_KEY_REUSED: { title: 'Permintaan sudah digunakan', message: 'Muat ulang data sebelum mengirim ulang.' },
  SEGREGATION_OF_DUTIES: { title: 'Perlu petugas lain', message: 'Tindakan ini harus diselesaikan oleh petugas yang berbeda.' },
  RATE_LIMITED: { title: 'Terlalu banyak permintaan', message: 'Tunggu sebentar, lalu coba lagi.' },
  DEPENDENCY_UNAVAILABLE: { title: 'Layanan belum tersedia', message: 'Coba lagi sebentar lagi.' },
};

export function createProblemDetails(
  error: unknown,
  context: { requestId: string; correlationId: string; instance: string },
): ProblemDetails {
  const domainError = error instanceof DomainError ? error : undefined;
  const registered = domainError ? findErrorCode(domainError.code) : undefined;
  const code = registered ? domainError!.code : 'INTERNAL';
  const status = error instanceof MalformedRequestError ? 400 : Number.parseInt(registered?.httpCategory ?? '500', 10);
  const domainCopy = registered && 'copyComplete' in registered && registered.copyComplete
    ? { title: registered.title, message: registered.explanation }
    : undefined;
  const copy = baseCopy[code] ?? domainCopy ?? internalCopy;
  const problem = {
    type: `/errors/${code}`,
    title: copy.title,
    status,
    detail: copy.message,
    instance: context.instance,
    code,
    message: copy.message,
    requestId: context.requestId,
    correlationId: context.correlationId,
    permittedActions: domainError?.permittedActions ?? [],
    ...(domainError?.fieldErrors ? { fieldErrors: domainError.fieldErrors } : {}),
    retryable: status === 429 || status === 503,
  };
  return ProblemDetailsSchema.parse(problem);
}
