import { PDD_OUTSIDE_SPEED_KEYS, type NormativeRules } from './normative-parameters'

export const pddRoads = {
  ordinary: 'Остальная дорога',
  motorway: 'Автомагистраль',
  residential: 'Жилая/велосипедная зона или двор',
} as const
export const pddVehicles = {
  light: 'Мотоциклы, легковые, грузовые до 3,5 т',
  heavy: 'Грузовые свыше 3,5 т или легковой с прицепом',
  busSeated: 'Автобус: только сидящие пассажиры, места с ремнями',
  busOther: 'Другой автобус',
  children: 'Автобус: организованная перевозка групп детей',
  peopleTruck: 'Грузовой: люди в кузове',
  towing: 'Буксировка механического ТС',
  permit: 'Перевозка по специальному разрешению',
} as const

/** Справочное значение для явно выбранных условий. Не устанавливает скорость всего потока. */
export function pddSpeedReference(
  location: 'in' | 'out' | 'auto' | '',
  road: keyof typeof pddRoads | '',
  vehicle: keyof typeof pddVehicles | '',
  rules: NormativeRules,
): { speed: number; source: string; confirmed: boolean; applicable: boolean } | null {
  if (location === 'auto' || location === '' || !road || !vehicle || vehicle === 'permit')
    return null
  if (road === 'motorway' && location === 'in') return null
  const ids: string[] = []
  let speed: number
  if (road === 'residential') {
    speed = rules.pddSpeedLimits.residential
    ids.push('pdd-speed-residential')
  } else if (location === 'in') {
    speed = rules.allowedSpeedKmh.in
    ids.push('pdd-speed-settlement')
  } else {
    const key: keyof typeof PDD_OUTSIDE_SPEED_KEYS =
      vehicle === 'light' || vehicle === 'towing'
        ? road === 'motorway'
          ? 'lightMotorway'
          : 'lightOrdinary'
        : vehicle === 'heavy'
          ? road === 'motorway'
            ? 'heavyMotorway'
            : 'heavyOrdinary'
          : vehicle
    speed = rules.pddSpeedLimits.outside[key]
    ids.push('pdd-speed-outside-conditions')
  }
  if (vehicle === 'towing') {
    speed = Math.min(speed, rules.pddSpeedLimits.towing)
    ids.push('pdd-speed-towing')
  }
  return {
    speed,
    source: ids.map((id) => rules.sources[id]).join('; '),
    confirmed: ids.every((id) => rules.confirmed[id]),
    applicable: road !== 'motorway',
  }
}
