import { useParams } from "react-router";
import { JobDetail } from "./detail";
import { JobsList } from "./list";

/** /jobs lists them; /jobs/:id shows one. */
export function Component() {
  const { id } = useParams();
  return id ? <JobDetail key={id} id={id} /> : <JobsList />;
}
