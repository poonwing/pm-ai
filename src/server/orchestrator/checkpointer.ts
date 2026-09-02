import path from 'path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { getAppDataDir } from '../paths.js';

let _checkpointer: SqliteSaver | null = null;

export function getOrchestratorCheckpointer(): SqliteSaver {
  if (!_checkpointer) {
    const dbPath = path.join(getAppDataDir(), 'langgraph-checkpoints.sqlite');
    _checkpointer = SqliteSaver.fromConnString(dbPath);
  }
  return _checkpointer;
}
