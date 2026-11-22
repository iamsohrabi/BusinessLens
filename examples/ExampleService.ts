export interface ExampleRecord {
  id: string;
  value: string;
}

export class ExampleService {
  private readonly records = new Map<string, ExampleRecord>();
  private nextId = 1;

  createRecord(input: Omit<ExampleRecord, "id">): string {
    const id = String(this.nextId++);
    this.records.set(id, { ...input, id });
    return id;
  }

  findRecord(id: string): ExampleRecord | undefined {
    return this.records.get(id);
  }
}
