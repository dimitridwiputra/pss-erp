import { Button } from './button';

export type TaskCardProps = {
  title: string;
  objectName: string;
  details: string;
  actionLabel: string;
  onAction?: () => void;
  headingLevel?: 2 | 3;
  state?: 'default' | 'loading' | 'disabled' | 'error';
  errorMessage?: string;
};

export function TaskCard({ title, objectName, details, actionLabel, onAction, headingLevel = 2, state = 'default', errorMessage }: TaskCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <article className="pss-task-card" aria-busy={state === 'loading'}>
      <p className="pss-task-kicker">{title}</p>
      <Heading>{objectName}</Heading>
      <p className="pss-task-details">{state === 'loading' ? 'Sedang memuat pekerjaan…' : details}</p>
      <Button label={actionLabel} state={state} {...(onAction ? { onClick: onAction } : {})} {...(errorMessage ? { errorMessage } : {})} />
    </article>
  );
}
