/**
 * Distill integration module.
 *
 * Registers delivery action handlers for Distill task session lifecycle events
 * emitted by the container's poll loop, and sets up the a2a inject endpoint
 * so the Distill daemon can wake NanoClaw agent groups directly.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleTaskEvent } from './task-events-handler.js';
import { setupInjectEndpoint } from './inject.js';

registerDeliveryAction('task_event', handleTaskEvent);
setupInjectEndpoint();
