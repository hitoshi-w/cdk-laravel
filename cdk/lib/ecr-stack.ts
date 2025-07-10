import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Repository } from "aws-cdk-lib/aws-ecr";

export class EcrStack extends Stack {
  public readonly appRepository: Repository;
  public readonly webRepository: Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.appRepository = new Repository(this, "WatanabeAppRepository", {
      repositoryName: "watanabe-app",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.webRepository = new Repository(this, "WatanabeWebRepository", {
      repositoryName: "watanabe-web",
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}