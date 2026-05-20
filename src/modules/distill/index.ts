/**
 * Distill integration module.
 *
 * Registers delivery action handlers for Distill task session lifecycle events
 * emitted by the container's poll loop.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleTaskEvent } from './task-events-handler.js';

registerDeliveryAction('task_event', handleTaskEvent);
