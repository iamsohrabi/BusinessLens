# ADR-0001: Example record storage

## Status

Accepted

## Decision

`ExampleService` keeps example records in memory for the lifetime of the
service instance. This is suitable only for demonstrating the BusinessLens
documentation experience; a production business workflow should select
persistent storage explicitly.
