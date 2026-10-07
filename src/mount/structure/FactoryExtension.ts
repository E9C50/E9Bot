import { planFactoryProduction, runFactoryProduction } from 'room/factory'

export default class FactoryExtension extends StructureFactory {
    public init(): void { planFactoryProduction(this) }
    public doWork(): void { runFactoryProduction(this) }
}
