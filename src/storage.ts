import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnyCheckpoint, AnyResearch, CheckpointData, StorageProvider } from "./types.ts";

export abstract class BaseStorageProvider implements StorageProvider {
  protected abstract readResearch(id: string): Promise<AnyResearch | undefined>;
  protected abstract writeResearch(research: AnyResearch): Promise<void>;
  protected abstract listResearchIds(): Promise<string[]>;

  async createResearch(name: string): Promise<AnyResearch> {
    const now = timestamp();
    const research: AnyResearch = {
      id: newId(),
      name,
      createdAt: now,
      updatedAt: now,
      checkpoints: [],
    };
    await this.writeResearch(research);
    return research;
  }

  async openResearch(name: string): Promise<AnyResearch> {
    for (const id of await this.listResearchIds()) {
      const research = await this.readResearch(id);
      if (research?.name === name) {
        return research;
      }
    }
    return this.createResearch(name);
  }

  async getResearch(id: string): Promise<AnyResearch | undefined> {
    return this.readResearch(id);
  }

  async listResearches(): Promise<string[]> {
    return this.listResearchIds();
  }

  newCheckpointId(): string {
    return newId();
  }

  async appendCheckpoint(
    researchId: string,
    id: string,
    data: CheckpointData<unknown>,
  ): Promise<AnyCheckpoint> {
    const research = await this.readResearch(researchId);
    if (research === undefined) {
      throw new Error(`Research not found: ${researchId}`);
    }
    if (research.checkpoints.some((existing) => existing.id === id)) {
      throw new Error(`Checkpoint already exists: ${id}`);
    }
    const now = timestamp();
    const checkpoint: AnyCheckpoint = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };
    research.checkpoints.push(checkpoint);
    research.updatedAt = now;
    await this.writeResearch(research);
    return checkpoint;
  }
}

export class InMemoryStorageProvider extends BaseStorageProvider {
  private store = new Map<string, AnyResearch>();

  protected async readResearch(id: string): Promise<AnyResearch | undefined> {
    const research = this.store.get(id);
    return research === undefined ? undefined : structuredClone(research);
  }

  protected async writeResearch(research: AnyResearch): Promise<void> {
    this.store.set(research.id, structuredClone(research));
  }

  protected async listResearchIds(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

export class FileStorageProvider extends BaseStorageProvider {
  private dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  protected async readResearch(id: string): Promise<AnyResearch | undefined> {
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      return JSON.parse(raw) as AnyResearch;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  protected async writeResearch(research: AnyResearch): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(research.id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(research, null, 2));
    await rename(tmp, target);
  }

  protected async listResearchIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

function newId(): string {
  return crypto.randomUUID();
}

function timestamp(): string {
  return new Date().toISOString();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
