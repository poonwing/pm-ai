import { STATUS_LABELS, TaskStatus } from '@shared/schemas';

export type BoardColumnId = TaskStatus | 'pending_review';

export const BOARD_COLUMN_LABELS: Record<BoardColumnId, string> = {
  draft: STATUS_LABELS.draft,
  todo: STATUS_LABELS.todo,
  in_progress: STATUS_LABELS.in_progress,
  pending_review: '待審批',
  done: STATUS_LABELS.done,
  cancelled: STATUS_LABELS.cancelled,
};

/** 看板欄位：處理中之後先待審批，通過才進完成。 */
export const BOARD_COLUMNS: BoardColumnId[] = [
  'draft',
  'todo',
  'in_progress',
  'pending_review',
  'done',
];

export function isTaskPendingReview(task: {
  status: TaskStatus;
  humanReviewed: boolean;
  review?: {
    required: boolean;
    reviewer_type: string;
    status: string;
  } | null;
}): boolean {
  if (task.status !== 'done') return false;
  const review = task.review;
  if (review?.required === false || review?.reviewer_type === 'none') return false;
  if (review?.status === 'approved') return false;
  if (!review || review.reviewer_type === 'human') {
    return !task.humanReviewed;
  }
  return review.status === 'pending' || review.status === 'none';
}

export function boardColumnForTask(task: {
  status: TaskStatus;
  humanReviewed: boolean;
  review?: {
    required: boolean;
    reviewer_type: string;
    status: string;
  } | null;
}): BoardColumnId {
  if (isTaskPendingReview(task)) return 'pending_review';
  return task.status;
}

export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ');
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '剛剛';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status];
}

export function statusColor(status: TaskStatus, humanReviewed?: boolean): string {
  if (status === 'done' && !humanReviewed) return 'text-amber-600 border-amber-300 bg-amber-50';
  const map: Record<TaskStatus, string> = {
    draft: 'text-zinc-600 border-zinc-300 bg-zinc-50',
    todo: 'text-blue-600 border-blue-300 bg-blue-50',
    in_progress: 'text-amber-600 border-amber-300 bg-amber-50',
    done: 'text-green-600 border-green-300 bg-green-50',
    cancelled: 'text-zinc-400 border-zinc-200 bg-zinc-50 line-through',
  };
  return map[status];
}

export function statusDotColor(status: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    draft: 'bg-zinc-400',
    todo: 'bg-blue-500',
    in_progress: 'bg-amber-500 pulse-dot',
    done: 'bg-green-500',
    cancelled: 'bg-zinc-300',
  };
  return map[status];
}
