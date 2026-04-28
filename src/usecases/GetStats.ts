import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

import { WeekDay } from "../generated/prisma/enums.js";
import { prisma } from "../lib/db.js";

dayjs.extend(utc);

const WEEKDAY_TO_DAY_NUMBER: Record<WeekDay, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

// Data Transfer Object
interface InputDto {
  userId: string;
  from: string;
  to: string;
}

interface OutputDto {
  workoutStreak: number;
  consistencyByDay: Record<
    string,
    {
      workoutDayCompleted: boolean;
      workoutDayStarted: boolean;
    }
  >;
  completedWorkoutsCount: number;
  conclusionRate: number;
  totalTimeInSeconds: number;
}

export class GetStats {
  async execute(dto: InputDto): Promise<OutputDto> {
    const fromDate = dayjs.utc(dto.from).startOf("day");
    const toDate = dayjs.utc(dto.to).endOf("day");

    // 1) Fetch all sessions in the range
    const sessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: {
          workoutPlan: {
            userId: dto.userId,
          },
        },
        startedAt: {
          gte: fromDate.toDate(),
          lte: toDate.toDate(),
        },
      },
    });

    // 2) Build consistencyByDay — only days with at least one session
    const consistencyByDay: Record<
      string,
      { workoutDayCompleted: boolean; workoutDayStarted: boolean }
    > = {};

    const sessionsByDate = new Map<
      string,
      Array<{ startedAt: Date; completedAt: Date | null }>
    >();

    sessions.forEach((session) => {
      const dateKey = dayjs.utc(session.startedAt).format("YYYY-MM-DD");
      const existing = sessionsByDate.get(dateKey) ?? [];
      existing.push({
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      });
      sessionsByDate.set(dateKey, existing);
    });

    sessionsByDate.forEach((daySessions, dateKey) => {
      const workoutDayStarted = daySessions.length > 0;
      const workoutDayCompleted = daySessions.some(
        (session) => session.completedAt !== null
      );
      consistencyByDay[dateKey] = { workoutDayCompleted, workoutDayStarted };
    });

    // 3) completedWorkoutsCount
    const completedSessions = sessions.filter(
      (session) => session.completedAt !== null
    );
    const completedWorkoutsCount = completedSessions.length;

    // 4) conclusionRate
    const conclusionRate =
      sessions.length > 0 ? completedWorkoutsCount / sessions.length : 0;

    // 5) totalTimeInSeconds
    const totalTimeInSeconds = completedSessions.reduce((total, session) => {
      const start = dayjs.utc(session.startedAt);
      const end = dayjs.utc(session.completedAt!);
      return total + end.diff(start, "second");
    }, 0);

    // 6) workoutStreak
    const workoutStreak = await this.calculateStreak(dto.userId);

    return {
      workoutStreak,
      consistencyByDay,
      completedWorkoutsCount,
      conclusionRate,
      totalTimeInSeconds,
    };
  }

  private async calculateStreak(userId: string): Promise<number> {
    // Get active workout plan days
    const activeWorkoutPlan = await prisma.workoutPlan.findFirst({
      where: { userId, isActive: true },
      include: { workoutDays: true },
    });

    if (!activeWorkoutPlan) {
      return 0;
    }

    const planWeekDays = activeWorkoutPlan.workoutDays.map(
      (day) => WEEKDAY_TO_DAY_NUMBER[day.weekDay]
    );

    // Fetch all completed sessions ordered by startedAt desc
    const allCompletedSessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: {
          workoutPlan: { userId, isActive: true },
        },
        completedAt: { not: null },
      },
      orderBy: { startedAt: "desc" },
    });

    if (allCompletedSessions.length === 0) {
      return 0;
    }

    // Group completed sessions by date
    const completedDates = new Set(
      allCompletedSessions.map((session) =>
        dayjs.utc(session.startedAt).format("YYYY-MM-DD")
      )
    );

    // Walk backwards from the most recent completed session date
    let streak = 0;
    let checkDate = dayjs.utc(allCompletedSessions[0].startedAt);

    while (true) {
      const dateKey = checkDate.format("YYYY-MM-DD");
      const dayNumber = checkDate.day();
      const isPlanDay = planWeekDays.includes(dayNumber);

      if (!isPlanDay) {
        checkDate = checkDate.subtract(1, "day");
        continue;
      }

      if (completedDates.has(dateKey)) {
        streak++;
        checkDate = checkDate.subtract(1, "day");
      } else {
        break;
      }
    }

    return streak;
  }
}
