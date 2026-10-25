/** Salon appointments (docs/planning/ui-refresh/salon-spec.md S5-S7). */
export {
  appointmentForSale,
  bookAppointment,
  closeAppointment,
  getAppointment,
  listDay,
  setAppointmentStatus,
  updateAppointment,
  type AppointmentDay,
  type AppointmentStatus,
  type AppointmentView,
} from "./appointments";
export { clock, daySlots, SLOT_MIN } from "./slots";
