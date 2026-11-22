# ExampleService
Path: `examples/ExampleService.ts`
Layer: service
Purpose: Coordinates basic record operations for an example business workflow. This sample exists to demonstrate how BusinessLens presents class and method documentation.
Responsibilities:
- Create a record and return its identifier.
- Find a record by its identifier.
Dependencies:
- `Map` – stores example records in memory.
Flow (key entry methods only):
Caller → `createRecord(input)` → store record in memory → return new identifier
Caller → `findRecord(id)` → look up record in memory → return record or `undefined`
Methods:
## createRecord(input) → string
  Purpose: Creates an in-memory record from the supplied data and returns its identifier.
  Logic:
    1. Accepts the record input.
    2. Generates the next sequential identifier.
    3. Stores the completed record in the local map and returns its identifier.
  Calls: None – record storage is handled directly by the class.
  Called by: example consumer
  Side effects: in-memory state write
  Edge cases: Records are not persisted beyond the lifetime of this service instance.
## findRecord(id) → Record | undefined
  Purpose: Retrieves an in-memory record using its identifier.
  Logic:
    1. Accepts a record identifier.
    2. Looks up the identifier in the local map and returns the matching record.
  Calls: None – record lookup is handled directly by the class.
  Called by: example consumer
  Side effects: none
  Edge cases: Returns `undefined` when no record matches.
