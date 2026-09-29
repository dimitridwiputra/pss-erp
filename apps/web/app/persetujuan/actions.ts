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

export async function decideApprovalAction(formData: FormData): Promise<void> {
  const input = DecisionFormSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) redirect('/persetujuan?result=invalid');
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
  if (response.ok) {
    revalidatePath('/persetujuan');
    redirect('/persetujuan?result=done');
  }
  const body: unknown = await response.json().catch(() => null);
  const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
  if (code === 'MFA_REQUIRED') redirect('/persetujuan?result=mfa');
  if (code === 'STALE_DATA') redirect('/persetujuan?result=stale');
  redirect('/persetujuan?result=error');
}
