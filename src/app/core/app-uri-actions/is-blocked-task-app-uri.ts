const BLOCKED_TASK_APP_URI_HOSTS: readonly string[] = [
  'create-task',
  'complete-task',
  'task-toggle-start',
];

export const isBlockedTaskAppUri = (url: string): boolean => {
  try {
    return BLOCKED_TASK_APP_URI_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};
