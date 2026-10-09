import { ReplayWorkspace } from "@/components/replay-workspace";
import { loadStrategyConfigs } from "@/lib/strategies/load";

export default function HomePage() {
  const strategies = loadStrategyConfigs();
  return <ReplayWorkspace strategies={strategies} />;
}
