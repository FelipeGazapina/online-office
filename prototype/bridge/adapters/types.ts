import type {
  Employee,
  EmployeeStatus,
  InterruptStyle,
  ProjectBlock,
  QuestionId,
} from '../../shared/protocol.ts';

// What the company hands each session. `employee` and `block` are live views of company state;
// every mutation goes back through the callbacks so persistence and broadcast stay in one place.
export type SessionHost = {
  readonly employee: Readonly<Employee>;
  readonly block: Readonly<ProjectBlock>;
  readonly companyName: string;
  setStatus(status: EmployeeStatus): void;
  setActivity(text: string): void;
  setSessionId(id: string): void;
  said(text: string): void;
  log(line: string): void;
  drawWhiteboard(title: string, mermaid: string): void;
  // Company awards the XP. Adapters call this once per finished task.
  taskCompleted(): void;
};

// One per employee. Construction must be cheap: the real adapter starts its process on first message.
export interface EmployeeSession {
  assign(task: string): void;
  // Company routes interjections to a blocked employee into `answer`, so this only sees idle/working/error.
  interject(text: string, style: InterruptStyle): void;
  answer(questionId: QuestionId, text: string): void;
  stop(): void;
}

export type SessionFactory = (host: SessionHost) => EmployeeSession;
