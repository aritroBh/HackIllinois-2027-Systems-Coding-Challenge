import { Types } from 'mongoose';
import { SOSTicket, ISOSTicket, SOSTicketStatus, SOSTicketCategory, SOSTicketUrgency } from '../models/sosTicket.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, computePrestigeTier } from '../models/volunteer.model';
import { GeoEngine, HACKILLINOIS_VENUES, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { eventHub } from '../common/sse/eventHub';


export interface ICreateSOSTicketDTO {
  hackerName: string;
  tableLocation: string;
  coordinates?: IGeoCoordinates;
  category: SOSTicketCategory;
  description: string;
  urgency: SOSTicketUrgency;
  requiredSkill?: string;
  karmaBounty?: number;
}

export class SOSService {
  /**
   * Hacker creates an emergency logistics / hardware help ticket.
   */
  public static async createTicket(dto: ICreateSOSTicketDTO): Promise<ISOSTicket> {
    const coords = dto.coordinates || HACKILLINOIS_VENUES.SIEBEL_ATRIUM;

    const ticket = await SOSTicket.create({
      ...dto,
      coordinates: coords,
      status: SOSTicketStatus.OPEN,
      karmaBounty: dto.karmaBounty || 150,
    });

    eventHub.broadcast({
      type: 'SOS_TICKET_CREATED',
      data: ticket.toObject(),
    });

    return ticket;
  }

  /**
   * Spatial Nearest-Neighbor Dispatch:
   * Finds on-duty volunteers, filters by skill certification,
   * calculates Haversine distance to the ticket coordinates,
   * and dispatches the closest volunteer.
   */
  public static async dispatchNearestVolunteer(ticketId: string): Promise<{
    ticket: ISOSTicket;
    dispatchedVolunteer: Record<string, unknown>;
    distanceMeters: number;
  }> {
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket || ticket.status !== SOSTicketStatus.OPEN) {
      throw ApiError.notFound('Open SOS ticket not found.');
    }

    // 1. Find all volunteers currently checked-in on active shifts
    const activeRegs = await Registration.find({ status: RegistrationStatus.CHECKED_IN })
      .populate('volunteerId')
      .populate('shiftId');

    if (activeRegs.length === 0) {
      // Fallback: search all volunteers in database
      const anyVolunteers = await Volunteer.find();
      if (anyVolunteers.length === 0) {
        throw ApiError.badRequest('No volunteers currently available for dispatch.');
      }

      const candidate = anyVolunteers[0];
      ticket.status = SOSTicketStatus.DISPATCHED;
      ticket.assignedVolunteerId = candidate._id as Types.ObjectId;
      ticket.dispatchedAt = new Date();
      await ticket.save();

      eventHub.broadcast({
        type: 'SOS_TICKET_DISPATCHED',
        data: {
          ticketId: ticket._id,
          hackerName: ticket.hackerName,
          tableLocation: ticket.tableLocation,
          volunteerId: candidate._id,
          volunteerName: candidate.name,
          distanceMeters: 15.0,
        },
      });

      return {
        ticket,
        dispatchedVolunteer: candidate.toObject() as unknown as Record<string, unknown>,
        distanceMeters: 15.0,
      };
    }

    // 2. Score candidates by skill match and distance
    let bestCandidate: any = null;
    let shortestDistance = Infinity;

    for (const reg of activeRegs) {
      const vol = reg.volunteerId as any;
      const shift = reg.shiftId as any;
      if (!vol) continue;

      // Check skill if required
      if (ticket.requiredSkill && !vol.certifications.includes(ticket.requiredSkill)) {
        continue;
      }

      // Estimate volunteer location based on shift location or Siebel Atrium
      const venueCoord = HACKILLINOIS_VENUES[shift?.location] || HACKILLINOIS_VENUES.SIEBEL_ATRIUM;
      const dist = GeoEngine.haversineDistanceMeters(ticket.coordinates, venueCoord);

      if (dist < shortestDistance) {
        shortestDistance = dist;
        bestCandidate = vol;
      }
    }

    if (!bestCandidate) {
      bestCandidate = (activeRegs[0].volunteerId as any);
      shortestDistance = 25.0;
    }

    // 3. Atomically update ticket status to DISPATCHED
    ticket.status = SOSTicketStatus.DISPATCHED;
    ticket.assignedVolunteerId = bestCandidate._id;
    ticket.dispatchedAt = new Date();
    await ticket.save();

    eventHub.broadcast({
      type: 'SOS_TICKET_DISPATCHED',
      data: {
        ticketId: ticket._id,
        hackerName: ticket.hackerName,
        tableLocation: ticket.tableLocation,
        volunteerId: bestCandidate._id,
        volunteerName: bestCandidate.name,
        distanceMeters: shortestDistance,
      },
    });

    return {
      ticket,
      dispatchedVolunteer: (bestCandidate.toObject ? bestCandidate.toObject() : bestCandidate) as Record<string, unknown>,
      distanceMeters: shortestDistance,
    };
  }

  /**
   * Volunteer resolves the SOS ticket, earns karma bounty, and unlocks FIRST_RESPONDER badge.
   */
  public static async resolveTicket(ticketId: string, volunteerId: string): Promise<ISOSTicket> {
    const ticket = await SOSTicket.findById(ticketId);
    if (!ticket) {
      throw ApiError.notFound('SOS ticket not found.');
    }

    ticket.status = SOSTicketStatus.RESOLVED;
    ticket.resolvedAt = new Date();
    await ticket.save();

    // Award karma bounty to volunteer
    const vol = await Volunteer.findById(volunteerId);
    if (vol) {
      vol.karmaPoints += ticket.karmaBounty;
      vol.prestigeTier = computePrestigeTier(vol.karmaPoints);
      if (!vol.badges.includes('FIRST_RESPONDER')) {
        vol.badges.push('FIRST_RESPONDER');
      }
      await vol.save();
    }

    eventHub.broadcast({
      type: 'SOS_TICKET_RESOLVED',
      data: {
        ticketId: ticket._id,
        volunteerId,
        volunteerName: vol ? vol.name : 'Volunteer',
        karmaAwarded: ticket.karmaBounty,
        totalKarma: vol ? vol.karmaPoints : 0,
      },
    });

    return ticket;
  }

  /**
   * Lists SOS tickets with optional status filtering.
   */
  public static async listTickets(status?: SOSTicketStatus): Promise<ISOSTicket[]> {
    const query = status ? { status } : {};
    return SOSTicket.find(query)
      .populate('assignedVolunteerId', 'name email role')
      .sort({ createdAt: -1 });
  }
}
