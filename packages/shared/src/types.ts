export interface TaskSubmission {
  task_type: string;
  payload: string;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  submitted_at: string;
}
