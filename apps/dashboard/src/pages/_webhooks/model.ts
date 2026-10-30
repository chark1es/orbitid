
export interface EndpointForm {
  id?: string;
  url: string;
  description: string;
  eventTypes: string[];
  allEvents: boolean;
}

export const EMPTY_FORM: EndpointForm = { url: "", description: "", eventTypes: [], allEvents: true };
