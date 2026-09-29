'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getPssServerAccessToken, getPssSession } from '../../auth';

const DecisionFormSchema = z.object({
  approvalId: z.uuid(),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(1).max(500),
});

/** APR-002.BR01: the inbox is re-read after every decision, so the badge and list stay honest. */
function backToInbox(result: string): never {
  revalidatePath('/persetujuan');
  redirect(`/persetujuan?result=${result}`);
}

/**
 * The decision itself is the platform approval command's job: this action only forwards it
 * and turns the RFC 9457 `code` into the message the approver reads. It holds no approval
 * rule, and the platform re-authorizes permission, scope, SoD, expiry and MFA server-side
 * (APR-002.BR01, RBAC-002).
 */
export async function decideApprovalAction(formData: FormData): Promise<void> {
  const input = DecisionFormSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) backToInbox('invalid');
  const session = await getPssSession();
  const token = await getPssServerAccessToken();
  if (!session?.pssAccount || session.error || !token) redirect('/masuk');
  const response = await fetch(
    `${process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000'}/platform/approvals/${input.data.approvalId}/decision`,
    {
      method: 'POST', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: input.data.decision, reason: input.data.reason }),
    },
  );
  if (response.ok) backToInbox('done');
  const body: unknown = await response.json().catch(() => null);
  const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
  if (code === 'MFA_REQUIRED') backToInbox('mfa');
  // APR-002.E1: somebody else already decided this request.
  if (code === 'STALE_DATA') backToInbox('stale');
  if (code === 'SEGREGATION_OF_DUTIES') backToInbox('sod');
  if (code === 'PERMISSION_DENIED') backToInbox('denied');
  if (code === 'NOT_FOUND' || code === 'INVALID_STATE_TRANSITION') backToInbox('expired');
  backToInbox('error');
}
