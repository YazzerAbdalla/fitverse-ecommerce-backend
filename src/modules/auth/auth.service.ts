import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UserRegisterDto } from './dto/user-register.dto';
import { Repository } from 'typeorm';
import User from './entity/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly logger: Logger,
  ) {}

  private saltOrRounds = 10;

  async register(userRegisterDto: UserRegisterDto) {
    const { email, password } = userRegisterDto;
    console.log('🚀 ~ AuthService ~ register ~ email:', email);
    // Check if this email already exist
    const isEmailExist = await this.userRepo.findOneBy({ email });
    if (isEmailExist) {
      this.logger.error(`User try to use duplicated email ${email}`);
      throw new BadRequestException('This email already exist.');
    }

    const hashedPassword = await bcrypt.hash(password, this.saltOrRounds);

    const newUser = { ...userRegisterDto, password: hashedPassword };

    await this.userRepo.save(newUser);

    this.logger.log(`New user with email ${email} had registered successfuly`);

    return { message: 'User created successfuly.', data: newUser };
  }

  userValidation() {}

  //Generate the jwt for user after validation his credentionals
  login() {}
}
