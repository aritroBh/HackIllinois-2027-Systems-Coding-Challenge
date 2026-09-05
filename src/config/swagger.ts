export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'WaveShift Nexus API',
    version: '1.0.0',
    description:
      'High-Performance Volunteer Scheduling & Operations Engine for HackIllinois Systems Team. Features atomic concurrency guarantees, waitlist cascade promotion, fatigue buffers, multi-party cyclic swaps, and dynamic HMAC-SHA256 attendance tokens.',
    contact: {
      name: 'HackIllinois Systems Candidate',
      url: 'https://github.com/HackIllinois/adonix',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000/api/v1',
      description: 'Local Development Server',
    },
  ],
  paths: {
    '/shifts': {
      get: {
        summary: 'List shifts with dynamic Karma surge pricing',
        tags: ['Shifts'],
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'location', in: 'query', schema: { type: 'string' } },
          { name: 'availableOnly', in: 'query', schema: { type: 'boolean' } },
          { name: 'surgeOnly', in: 'query', schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'List of enriched shifts' },
        },
      },
      post: {
        summary: 'Create a new shift',
        tags: ['Shifts'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'description', 'category', 'location', 'startTime', 'endTime', 'capacity'],
                properties: {
                  title: { type: 'string', example: 'Siebel Midnight Pizza Distribution' },
                  description: { type: 'string', example: 'Coordinate food distribution for 1,200 hackers' },
                  category: { type: 'string', enum: ['FOOD', 'LOGISTICS', 'SPONSOR_RELATIONS', 'INFO_DESK', 'HARDWARE_LAB', 'MENTOR_SUPPORT', 'CLEANUP'] },
                  location: { type: 'string', example: 'Siebel Center Atrium' },
                  startTime: { type: 'string', format: 'date-time' },
                  endTime: { type: 'string', format: 'date-time' },
                  capacity: { type: 'integer', example: 5 },
                  requiredSkills: { type: 'array', items: { type: 'string' }, example: ['FOOD_HANDLING'] },
                  baseKarma: { type: 'integer', example: 120 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Shift created' },
        },
      },
    },
    '/shifts/{id}': {
      get: {
        summary: 'Get shift details with confirmed and waitlisted roster',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift details' },
          404: { description: 'Shift not found' },
        },
      },
      patch: {
        summary: 'Update shift details',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift updated' },
        },
      },
      delete: {
        summary: 'Soft-delete a shift',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift deactivated' },
        },
      },
    },
    '/registrations': {
      post: {
        summary: 'Atomically reserve a shift slot or join FIFO waitlist',
        tags: ['Registrations'],
        parameters: [
          {
            name: 'idempotency-key',
            in: 'header',
            schema: { type: 'string' },
            description: 'Unique client key to prevent duplicate booking under network retries',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['shiftId', 'volunteerId'],
                properties: {
                  shiftId: { type: 'string' },
                  volunteerId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Slot confirmed or waitlisted' },
          409: { description: 'Schedule collision, buffer conflict, or already registered' },
        },
      },
      get: {
        summary: 'List shift registrations',
        tags: ['Registrations'],
        responses: {
          200: { description: 'List of registrations' },
        },
      },
    },
    '/registrations/{id}': {
      delete: {
        summary: 'Cancel registration and trigger automatic waitlist cascade promotion',
        tags: ['Registrations'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Registration cancelled; waitlist candidate promoted if present' },
        },
      },
    },
    '/volunteers': {
      get: {
        summary: 'List all volunteers with prestige tiers and badges',
        tags: ['Volunteers'],
        responses: {
          200: { description: 'List of volunteers' },
        },
      },
      post: {
        summary: 'Register a volunteer',
        tags: ['Volunteers'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email'],
                properties: {
                  name: { type: 'string', example: 'Alex Morgan' },
                  email: { type: 'string', example: 'alex@illinois.edu' },
                  certifications: { type: 'array', items: { type: 'string' }, example: ['DRIVERS_LICENSE', 'FIRST_AID'] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Volunteer registered' },
        },
      },
    },
    '/swaps': {
      post: {
        summary: 'Create a shift swap proposal',
        tags: ['Swaps'],
        responses: { 201: { description: 'Swap proposed' } },
      },
      get: {
        summary: 'List shift swap proposals',
        tags: ['Swaps'],
        responses: { 200: { description: 'List of swaps' } },
      },
    },
    '/swaps/{id}/accept': {
      post: {
        summary: 'Accept a bilateral shift swap with mutual conflict verification',
        tags: ['Swaps'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Swap executed atomically' } },
      },
    },
    '/swaps/cycles/resolve': {
      post: {
        summary: 'Discover and resolve multi-party directed cycle trades (e.g. A->B->C->A)',
        tags: ['Swaps'],
        responses: { 200: { description: 'Cycles discovered and executed' } },
      },
    },
    '/attendance/token': {
      post: {
        summary: 'Generate a dynamic 30s rotating HMAC QR code token',
        tags: ['Attendance'],
        responses: { 200: { description: 'Token generated with 30s TTL' } },
      },
    },
    '/attendance/verify': {
      post: {
        summary: 'Verify dynamic QR code and mark check-in',
        tags: ['Attendance'],
        responses: {
          200: { description: 'Check-in verified' },
          400: { description: 'Token expired or malformed' },
          409: { description: 'Replay attack detected' },
        },
      },
    },
    '/attendance/{id}/checkout': {
      post: {
        summary: 'Check out and award surge-multiplied Karma points',
        tags: ['Attendance'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Checked out; karma and hours updated' } },
      },
    },
    '/stats/leaderboard': {
      get: {
        summary: 'Get volunteer leaderboard ranked by Karma points',
        tags: ['Stats'],
        responses: { 200: { description: 'Leaderboard rankings' } },
      },
    },
    '/stats/operations': {
      get: {
        summary: 'Get real-time operational telemetry for hackathon organizers',
        tags: ['Stats'],
        responses: { 200: { description: 'Operations statistics' } },
      },
    },
    '/stats/events': {
      get: {
        summary: 'Real-time Server-Sent Events (SSE) stream',
        tags: ['Stats'],
        responses: { 200: { description: 'SSE event stream' } },
      },
    },
  },
};
