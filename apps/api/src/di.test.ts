// RQ-0015 follow-up: constructor injection by type only works if SWC emits decorator metadata
// under Vitest 4. If this fails, the toolchain (not the app) is broken.
import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class Clock {
  now(): number {
    return 42;
  }
}

@Injectable()
class UsesClock {
  constructor(readonly clock: Clock) {}
}

describe('NestJS dependency injection under Vitest + SWC', () => {
  it('resolves a constructor dependency from its type alone (decorator metadata emitted)', async () => {
    const mod = await Test.createTestingModule({ providers: [Clock, UsesClock] }).compile();
    expect(mod.get(UsesClock).clock.now()).toBe(42);
  });
});
