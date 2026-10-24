export interface EvidenceEntry { scenario: string; file: string; test: string; commit: string; provider: string; timestamp: string; result: string }
const ni = (): never => { throw new Error('not implemented'); };
export const formatTimestamp = (_d: Date): string => ni();
export const evidenceFilePath = (_o: { evidenceRoot: string; taskId: string; scenarioId: string; slug: string; date: Date }): string => ni();
export const appendManifestEntries = async (_p: string, _t: string, _e: EvidenceEntry[]): Promise<void> => ni();
export const findRepoRoot = (_s: string): string => ni();
export const resolveEvidenceContext = (_env: Record<string, string | undefined>, _cwd: string): { taskId: string; provider: string; repoRoot: string; evidenceRoot: string; commit: string } => ni();
