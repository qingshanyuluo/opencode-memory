export interface SourceSession {
  id: string;
  projectId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  payload: unknown;
}

export interface SourceMessage {
  id: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  payload: unknown;
}

export interface OpencodeSource {
  listSessions(updatedAfter?: number): Promise<SourceSession[]>;
  listMessages(sessionId: string, afterMessageId?: string): Promise<SourceMessage[]>;
}

export interface OpencodeSink {
  injectContext(sessionId: string, text: string): Promise<void>;
}
