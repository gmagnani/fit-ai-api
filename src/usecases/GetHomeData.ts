import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

import { NotFoundError } from "../errors/index.js";
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

const DAY_NUMBER_TO_WEEKDAY: Record<number, WeekDay> = {
  0: "SUNDAY",
  1: "MONDAY",
  2: "TUESDAY",
  3: "WEDNESDAY",
  4: "THURSDAY",
  5: "FRIDAY",
  6: "SATURDAY",
};

// Data Transfer Object
interface InputDto {
  userId: string;
  date: string;
}

interface OutputDto {
  activeWorkoutPlanId: string;
  todayWorkoutDay: {
    workoutPlanId: string;
    id: string;
    name: string;
    isRest: boolean;
    weekDay: WeekDay;
    estimatedDurationInSeconds: number;
    coverImageUrl?: string;
    exercisesCount: number;
  };
  workoutStreak: number;
  consistencyByDay: Record<
    string,
    {
      workoutDayCompleted: boolean;
      workoutDayStarted: boolean;
    }
  >;
}

export class GetHomeData {
  async execute(dto: InputDto): Promise<OutputDto> {
    const currentDate = dayjs.utc(dto.date);
    const currentWeekDay = DAY_NUMBER_TO_WEEKDAY[currentDate.day()];

    // 1) Find active workout plan
    const activeWorkoutPlan = await prisma.workoutPlan.findFirst({
      where: {
        userId: dto.userId,
        isActive: true,
      },
      include: {
        workoutDays: {
          include: {
            exercises: true,
            sessions: true,
          },
        },
      },
    });

    if (!activeWorkoutPlan) {
      throw new NotFoundError("Active workout plan not found");
    }

    // 2) Find today's workout day
    const todayWorkoutDay = activeWorkoutPlan.workoutDays.find(
      (day) => day.weekDay === currentWeekDay
    );

    if (!todayWorkoutDay) {
      throw new NotFoundError("Workout day not found for today");
    }

    // 3) Calculate week range (Sunday to Saturday) in UTC
    const weekStart = currentDate.startOf("week"); // Sunday 00:00:00
    const weekEnd = currentDate.endOf("week"); // Saturday 23:59:59

    // 4) Fetch all sessions for this user in the week range
    const sessionsInWeek = await prisma.workoutSession.findMany({
      where: {
        workoutDay: {
          workoutPlan: {
            userId: dto.userId,
          },
        },
        startedAt: {
          gte: weekStart.toDate(),
          lte: weekEnd.toDate(),
        },
      },
    });

    // 5) Build consistencyByDay — include ALL 7 days of the week
    const consistencyByDay: Record<
      string,
      { workoutDayCompleted: boolean; workoutDayStarted: boolean }
    > = {};

    for (let i = 0; i < 7; i++) {
      const day = weekStart.add(i, "day");
      const dateKey = day.format("YYYY-MM-DD");

      const daySessions = sessionsInWeek.filter(
        (session) =>
          dayjs.utc(session.startedAt).format("YYYY-MM-DD") === dateKey
      );

      const workoutDayStarted = daySessions.length > 0;
      const workoutDayCompleted = daySessions.some(
        (session) => session.completedAt !== null
      );

      consistencyByDay[dateKey] = {
        workoutDayCompleted,
        workoutDayStarted,
      };
    }

    // 6) Calculate workout streak
    const workoutStreak = this.calculateStreak(activeWorkoutPlan, dto.userId);

    return {
      activeWorkoutPlanId: activeWorkoutPlan.id,
      todayWorkoutDay: {
        workoutPlanId: activeWorkoutPlan.id,
        id: todayWorkoutDay.id,
        name: todayWorkoutDay.name,
        isRest: todayWorkoutDay.isRestDay,
        weekDay: todayWorkoutDay.weekDay,
        estimatedDurationInSeconds: todayWorkoutDay.estimatedDurationInSeconds,
        coverImageUrl: todayWorkoutDay.coverImageUrl ?? undefined,
        exercisesCount: todayWorkoutDay.exercises.length,
      },
      workoutStreak: await workoutStreak,
      consistencyByDay,
    };
  }

  private async calculateStreak(
    activeWorkoutPlan: {
      workoutDays: Array<{
        weekDay: WeekDay;
        isRestDay: boolean;
        sessions: Array<{
          startedAt: Date;
          completedAt: Date | null;
        }>;
      }>;
    },
    userId: string
  ): Promise<number> {
    // Get all workout days sorted by their weekday order
    const planWeekDays = activeWorkoutPlan.workoutDays.map(
      (day) => WEEKDAY_TO_DAY_NUMBER[day.weekDay]
    );

    // Fetch all completed sessions ordered by startedAt desc
    const allSessions = await prisma.workoutSession.findMany({
      where: {
        workoutDay: {
          workoutPlan: {
            userId,
            isActive: true,
          },
        },
        completedAt: { not: null },
      },
      include: {
        workoutDay: true,
      },
      orderBy: {
        startedAt: "desc",
      },
    });

    if (allSessions.length === 0) {
      return 0;
    }

    // Group completed sessions by date
    const completedDates = new Set(
      allSessions.map((session) =>
        dayjs.utc(session.startedAt).format("YYYY-MM-DD")
      )
    );

    // Walk backwards from the most recent completed session date
    let streak = 0;
    const mostRecentDate = dayjs.utc(allSessions[0].startedAt);
    let checkDate = mostRecentDate;

    while (true) {
      const dateKey = checkDate.format("YYYY-MM-DD");
      const dayNumber = checkDate.day();

      // Check if this day is a plan day
      const isPlanDay = planWeekDays.includes(dayNumber);

      if (!isPlanDay) {
        // Skip non-plan days
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
